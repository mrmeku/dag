import {
  errorMessage,
  resultActionKey,
  type MemoryFileSystem,
  type NodeResult,
  type Outputs,
} from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { describe, test } from "node:test";
import { readRunHistory } from "../history/index.ts";
import type { CiContext } from "../host/index.ts";
import { selectors } from "../kernel/index.ts";
import { clockAt, memoryRuntime, okExec } from "../memory/index.ts";
import {
  createMemoryArtifactStore,
  createMemoryCacheStore,
  createRecordingHost,
  type MemoryCacheStore,
  type RecordedHost,
} from "../recording/index.ts";
import { githubRenderer } from "../reporter/index.ts";
import { createRunStore, type RunListener } from "../run-store/index.ts";
import { defineWorkflow, settled, type Ports } from "../workflow/index.ts";
import { runJob, runPost, runWorkflow } from "./index.ts";

type ExecOptions = Parameters<Ports["exec"]["run"]>[1];
type ExecResult = Awaited<ReturnType<Ports["exec"]["run"]>>;

const CACHE_DIR = "/cache";
const HISTORY_DIR = "/state/history";
const BUILD_LOG_DIR = "/state/build-logs";
const DURATIONS_DIR = "/state/durations";

/**
 * Ports of doubles: a fresh memory runtime's members, whose timer fires only by hand and whose
 * lockfile a test can hold, a recording host with `context`, and memory stores.
 */
function testPorts(
  opts: {
    clock?: Ports["clock"];
    context?: Partial<CiContext>;
    cacheStore?: MemoryCacheStore;
    files?: Record<string, string>;
  } = {},
) {
  const runtime = memoryRuntime({
    ...(opts.clock && { clock: opts.clock }),
    ...(opts.files && { files: opts.files }),
  });
  const rec = createRecordingHost(opts.context);
  const cacheStore = opts.cacheStore ?? createMemoryCacheStore();
  const ports: Ports = {
    exec: runtime.exec,
    fs: runtime.fs,
    clock: runtime.clock,
    startTimer: runtime.startTimer,
    host: rec.host,
    cacheStore,
    artifactStore: createMemoryArtifactStore(),
    lockfile: runtime.lockfile,
    fileMatcher: runtime.fileMatcher,
    env: runtime.env,
  };
  return {
    ports,
    fs: runtime.fs,
    rec,
    cacheStore,
    timer: runtime.startTimer,
    lockfile: runtime.lockfile,
  };
}

const exited = (code: number, output = ""): ExecResult => ({
  ended: "exited",
  code,
  stdout: output,
  stderr: "",
  output,
  ok: code === 0,
});

/** How a node settled, in the words the run's output uses: built or cached, or its status. */
const outcomeOf = (result: NodeResult) =>
  result.status === "succeeded" ? (result.details.actionRan ? "built" : "cached") : result.status;
const statusesOf = (results: NodeResult[]) =>
  Object.fromEntries(results.map((result) => [result.name, outcomeOf(result)]));

/** The lines of the first logged group of node `name`, whatever its icon and suffix. */
const groupLines = (log: RecordedHost["log"], name: string) =>
  log.flatMap((e) =>
    typeof e !== "string" && e.title.slice(e.title.indexOf(" ") + 1).startsWith(`${name} (`)
      ? [e.lines]
      : [],
  )[0];
const titlesOf = (log: RecordedHost["log"]) =>
  log.map((e) => (typeof e === "string" ? e : e.title));

/** The history files runs left in HISTORY_DIR, parsed. */
const histories = async (fs: MemoryFileSystem) =>
  Promise.all(
    [...fs.files.keys()]
      .filter((k) => k.startsWith(`${HISTORY_DIR}/`) && k.endsWith(".json"))
      .map((k) => readRunHistory(fs, k)),
  );
const underCacheDir = (fs: MemoryFileSystem) =>
  [...fs.files.keys()].filter((k) => k.startsWith(`${CACHE_DIR}/`));

const parsed = async (fs: MemoryFileSystem, path: string): Promise<unknown> =>
  JSON.parse(await fs.readText(path));

const signalOf = (opts: ExecOptions | undefined) => {
  const signal = opts?.signal;
  assert.ok(signal, "signal for the command");
  return signal;
};

/** Resolves once the recording host draws the group of node `name`. */
const groupDrawn = (ports: Ports, name: string) =>
  new Promise<void>((resolve) => {
    const group = ports.host.group;
    ports.host.group = (title, lines) => {
      group(title, lines);
      if (title.slice(title.indexOf(" ") + 1).startsWith(`${name} (`)) resolve();
    };
  });

/** A listener double recording each hook it hears, in order. */
const recordingListener = (heard: string[]): RunListener => ({
  begin: (pass) => void heard.push(`begin ${pass.title}`),
  settle: (nodeState) => void heard.push(`settle ${nodeState.node.name} ${nodeState.status}`),
  finish: (pass) => void heard.push(`finish ${pass.title}`),
  interrupt: (run) => void heard.push(`interrupt ${run.lifecycle.status}`),
  close: (run) => void heard.push(`close ${run.lifecycle.status}`),
});

describe("cancel, then post", () => {
  test("the semantics' worked test: a cancel during the tests still stops the database", async () => {
    const { ports, fs, rec } = testPorts();
    const controller = new AbortController();
    const calls: string[] = [];
    ports.exec = {
      run: async (argv) => {
        calls.push(argv.join(" "));
        if (argv[0] === "test") controller.abort();
        return exited(0);
      },
    };
    const ci = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({
          name: "up:db",
          cmd: ["compose", "up", "-d"],
          post: { name: "down:db", cmd: ["compose", "down"] },
        });
        workflow.task({ name: "test", cmd: ["test"], deps: { db }, inputs: { version: "1" } });
      },
    });
    const options = {
      implementation: ci.implementation,
      ports,
      cacheDir: CACHE_DIR,
      historyDir: HISTORY_DIR,
    };
    const run = await runWorkflow({ ...options, signal: controller.signal });
    const cachedAfterRun = underCacheDir(fs);
    const post = await runPost(options);
    assert.deepEqual(
      {
        run: [run.exitCode, Object.fromEntries(run.results.map((r) => [r.name, r.status]))],
        cachedAfterRun,
        post: [post.exitCode, post.results.map((r) => `${r.name} ${r.status}`)],
        calls,
        banners: rec.log
          .flatMap((e) => (typeof e === "string" ? [] : [e.title]))
          .filter((t) => !t.startsWith("✔") && !t.startsWith("◼")),
      },
      {
        // test's command exited 0, but the cancel fired while it ran.
        run: [130, { "up:db": "succeeded", test: "cancelled", "down:db": "cancelled" }],
        cachedAfterRun: [],
        post: [0, ["down:db succeeded"]],
        calls: ["compose up -d", "test", "compose down"],
        banners: ["3 nodes", "post · 1 of 1 post steps owed"],
      },
    );
  });

  test("a cancelled run records what settled in its history; the post pass stops the service from that history, under the workflow's summary, and saves no cache; a second pass finds nothing", async () => {
    const controller = new AbortController();
    const calls: string[][] = [];
    const service = createMemoryCacheStore(["bun-old"]);
    const { ports, fs, rec } = testPorts({ cacheStore: service });
    // `db start` writes the pid it is asked for; `db stop` reads it from PID; `slow` runs until
    // the cancel interrupts it.
    let stoppedPid: string | undefined;
    ports.exec = {
      run: async (cmd, opts) => {
        calls.push(cmd);
        const [program, verb, path] = cmd;
        if (program === "db" && verb === "start" && path) await fs.writeText(path, "7");
        const pidFile = opts?.env?.PID;
        if (program === "db" && verb === "stop" && pidFile) stoppedPid = await fs.readText(pidFile);
        if (program !== "slow") return exited(0);
        return new Promise((resolve) =>
          signalOf(opts).addEventListener("abort", () => {
            opts?.onOutput?.("killed by SIGINT\n");
            resolve({
              ended: "signalled",
              code: -1,
              stdout: "",
              stderr: "killed by SIGINT\n",
              output: "killed by SIGINT\n",
              ok: false,
            });
          }),
        );
      },
    };
    const def = defineWorkflow({
      summary: [(r) => r.nodes.map(({ node, result }) => `${node.name} ${outcomeOf(result)}`)],
      implementation: (workflow) => {
        const bun = workflow.cache({
          name: "bun",
          path: ["~/.bun"],
          key: "bun-new",
          restoreKeys: ["bun-"],
        });
        const db = workflow.task({
          name: "up:db",
          cmd: ({ out }) => ["db", "start", out.pid],
          outputs: { pid: "pid" },
          post: { name: "down:db", cmd: ["db", "stop"], env: ({ main }) => ({ PID: main.pid }) },
        });
        const fast = workflow.task({
          name: "fast",
          cmd: ["fast"],
          deps: { bun: bun.restore, db },
          cacheable: false,
        });
        const slow = workflow.task({
          name: "slow",
          cmd: ["slow"],
          deps: { bun: bun.restore, db },
          cacheable: false,
        });
        workflow.task({ name: "after", cmd: ["after"], deps: { fast, slow } });
        // down:db waits for fast, slow and after, which use its task; the save for every task.
        bun.save();
      },
    });
    const common = {
      implementation: def.implementation,
      ...(def.summary && { summary: def.summary }),
      ports,
      cacheDir: CACHE_DIR,
      historyDir: HISTORY_DIR,
    };
    const fastSettled = groupDrawn(ports, "fast");
    const running = runWorkflow({ ...common, signal: controller.signal });
    await fastSettled;
    controller.abort();
    const run = await running;
    const recorded = (await histories(fs)).map((j) => j.results);
    const post = await runPost(common);
    const again = await runPost(common);
    // The workflow's own section, in both passes; the post pass draws its owed steps alone.
    const summaries = [
      [
        "## run",
        "",
        "restore:bun built",
        "up:db built",
        "fast built",
        "slow cancelled",
        "after cancelled",
        "down:db cancelled",
        "save:bun cancelled",
        "",
      ].join("\n"),
      ["## run · post", "", "down:db built", ""].join("\n"),
    ];
    assert.deepEqual(
      {
        run: { cancelled: run.cancelled, failed: run.failed, statuses: statusesOf(run.results) },
        recorded,
        post: statusesOf(post.results),
        again: statusesOf(again.results),
        calls: calls.map((c) => c.slice(0, 2)),
        stoppedPid,
        saved: [...service.savedCaches.keys()],
        headersStartsAndRecaps: titlesOf(rec.log).filter(
          (t) => /^(\d+ nodes|post · |▷ )/.test(t) || t.includes(" · built "),
        ),
        summaries: rec.summaries,
        markdowns: [run.markdown, post.markdown],
        slowLog: groupLines(rec.log, "slow"),
      },
      {
        run: {
          cancelled: true,
          failed: 4,
          statuses: {
            "restore:bun": "built",
            "up:db": "built",
            fast: "built",
            slow: "cancelled",
            after: "cancelled",
            "save:bun": "cancelled",
            "down:db": "cancelled",
          },
        },
        // Each node's whole result, as the run settled it.
        recorded: [Object.fromEntries(run.results.map((r) => [r.name, r]))],
        // A save is ordinary work: the cancel stopped it, and nothing owes it.
        post: { "down:db": "built" },
        again: {},
        calls: [["db", "start"], ["fast"], ["slow"], ["db", "stop"]],
        stoppedPid: "7",
        saved: ["bun-old"],
        headersStartsAndRecaps: [
          "7 nodes",
          "▷ restore:bun",
          "▷ up:db",
          "▷ fast",
          "▷ slow",
          "◼︎ cancelled, 4 nodes not run · run · built 3 · cached 0 · failed 0 · skipped 0 · cancelled 4 · wall 19.0s",
          "post · 1 of 1 post steps owed",
          "▷ down:db",
          "✔︎ 1 node succeeded · run · post · built 1 · cached 0 · failed 0 · skipped 0 · wall 2.0s",
        ],
        summaries,
        // Each pass's outcome holds the summary it published.
        markdowns: summaries,
        slowLog: ["killed by SIGINT"],
      },
    );
  });
});

describe("runJob", () => {
  test("after a cancel, the same process runs the post steps owed in the run's selection, under its title and summary, and exits 130; it makes a store for each pass and an exit interrupts neither", async () => {
    const controller = new AbortController();
    const { ports, rec } = testPorts();
    const fastSettled = groupDrawn(ports, "fast");
    ports.exec = {
      run: async (cmd, opts) => {
        if (cmd[0] !== "slow") return exited(0);
        return new Promise((resolve) =>
          signalOf(opts).addEventListener("abort", () =>
            resolve({
              ended: "signalled",
              code: -1,
              stdout: "",
              stderr: "",
              output: "",
              ok: false,
            }),
          ),
        );
      },
    };
    const def = defineWorkflow({
      summary: [(r) => r.nodes.map(({ node, result }) => `${node.name} ${outcomeOf(result)}`)],
      implementation: (workflow) => {
        const fast = workflow.task({
          name: "fast",
          cmd: ["fast"],
          post: { name: "notify", cmd: ["notify"] },
        });
        workflow.task({ name: "slow", cmd: ["slow"], deps: { fast } });
        workflow.task({ name: "lint", cmd: ["lint"] });
      },
    });
    assert.ok(def.summary, "summary");
    const processEvents = new EventEmitter();
    const job = runJob(
      {
        implementation: def.implementation,
        workflowFile: "ci.ts",
        summary: def.summary,
        ports,
        cacheDir: CACHE_DIR,
        historyDir: HISTORY_DIR,
        only: ["slow"],
        signal: controller.signal,
      },
      processEvents,
    );
    await fastSettled;
    controller.abort();
    processEvents.emit("exit");
    assert.deepEqual(
      {
        code: await job,
        log: rec.log,
        summaries: rec.summaries,
        exitListeners: processEvents.listenerCount("exit"),
      },
      {
        code: 130,
        // lint is outside the selection; slow's dep fast is in it, and so is fast's post.
        log: [
          { title: "ci.ts · 3 of 4 nodes (--only slow)", lines: ["fast", "slow", "notify"] },
          "▷ fast",
          { title: "✔︎ fast (2.0s)", lines: [] },
          // Cancelled once it started, before its action ran.
          "▷ slow",
          "◼︎ slow: cancelled",
          "◼︎ notify: cancelled",
          "",
          "◼︎ cancelled, 2 nodes not run · ci.ts · built 1 · cached 0 · failed 0 · skipped 0 · cancelled 2 · wall 2.0s",
          "cancelled: slow, notify",
          { title: "post · 1 of 1 post steps owed", lines: ["notify"] },
          "▷ notify",
          { title: "✔︎ notify (2.0s)", lines: [] },
          "",
          "✔︎ 1 node succeeded · ci.ts · post · built 1 · cached 0 · failed 0 · skipped 0 · wall 2.0s",
        ],
        summaries: [
          ["## ci.ts", "", "fast built", "slow cancelled", "notify cancelled", ""].join("\n"),
          ["## ci.ts · post", "", "notify built", ""].join("\n"),
        ],
        exitListeners: 0,
      },
    );
  });

  test("reports both passes to a given store, and closes it once the post pass is done: an exit heard while the post pass runs interrupts it first", async () => {
    const { ports } = testPorts();
    const slowStarted = Promise.withResolvers<void>();
    const releaseStarted = Promise.withResolvers<void>();
    const releaseEnds = Promise.withResolvers<ExecResult>();
    ports.exec = {
      run: (cmd, opts) => {
        if (cmd[0] === "release") {
          releaseStarted.resolve();
          // It ignores signals, so only a second Ctrl-C ends the process.
          return releaseEnds.promise;
        }
        if (cmd[0] !== "slow") return Promise.resolve(exited(0));
        slowStarted.resolve();
        return new Promise((resolve) =>
          signalOf(opts).addEventListener("abort", () => resolve(exited(130))),
        );
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const fast = workflow.task({
          name: "fast",
          cmd: ["fast"],
          post: { name: "release", cmd: ["release"], retry: "once" },
        });
        workflow.task({ name: "slow", cmd: ["slow"], deps: { fast }, cacheable: false });
      },
    });
    const heard: string[] = [];
    const store = createRunStore({
      fs: ports.fs,
      durationsFile: `${DURATIONS_DIR}/ci.ts.json`,
      listeners: [recordingListener(heard)],
    });
    const processEvents = new EventEmitter();
    const controller = new AbortController();
    const job = runJob(
      {
        implementation,
        workflowFile: "ci.ts",
        ports,
        cacheDir: CACHE_DIR,
        historyDir: HISTORY_DIR,
        store,
        signal: controller.signal,
      },
      processEvents,
    );
    await slowStarted.promise;
    controller.abort();
    await releaseStarted.promise;
    processEvents.emit("exit");
    const atExit = [...heard];
    releaseEnds.resolve(exited(0));
    const code = await job;
    assert.deepEqual(
      { code, atExit, afterExit: heard.slice(atExit.length) },
      {
        code: 130,
        atExit: [
          "begin ci.ts",
          "settle fast succeeded",
          "settle slow cancelled",
          "settle release cancelled",
          "finish ci.ts",
          "begin ci.ts · post",
          "interrupt interrupted",
        ],
        // The lifecycle stays interrupted, and every close hook still runs.
        afterExit: ["settle release succeeded", "finish ci.ts · post", "close interrupted"],
      },
    );
  });

  test("a cancel moves a given store to cancelling, so its close is cancelled; a post pass owing nothing still begins on it", async () => {
    const { ports } = testPorts();
    const controller = new AbortController();
    ports.exec = {
      run: (_cmd, opts) =>
        new Promise((resolve) => {
          signalOf(opts).addEventListener("abort", () => resolve(exited(130)));
          controller.abort();
        }),
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) =>
        void workflow.task({ name: "slow", cmd: ["slow"], cacheable: false }),
    });
    const heard: string[] = [];
    const store = createRunStore({
      fs: ports.fs,
      durationsFile: `${DURATIONS_DIR}/ci.ts.json`,
      listeners: [recordingListener(heard)],
    });
    const code = await runJob(
      {
        implementation,
        workflowFile: "ci.ts",
        ports,
        cacheDir: CACHE_DIR,
        historyDir: HISTORY_DIR,
        store,
        signal: controller.signal,
      },
      new EventEmitter(),
    );
    assert.deepEqual(
      { code, heard },
      {
        code: 130,
        heard: [
          "begin ci.ts",
          "settle slow cancelled",
          "finish ci.ts",
          "begin ci.ts · post",
          "close cancelled",
        ],
      },
    );
  });

  test("rejects with what a pass threw, and closes the given store with it", async () => {
    const { ports } = testPorts();
    const slowStarted = Promise.withResolvers<void>();
    ports.exec = {
      run: (cmd, opts) => {
        if (cmd[0] !== "slow") return Promise.resolve(exited(0));
        slowStarted.resolve();
        return new Promise((resolve) =>
          signalOf(opts).addEventListener("abort", () => resolve(exited(130))),
        );
      },
    };
    let builds = 0;
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        // The post pass builds the graph again, which this workflow cannot.
        if (builds++ > 0) throw new Error("second build");
        const fast = workflow.task({
          name: "fast",
          cmd: ["fast"],
          post: { name: "release", cmd: ["release"] },
        });
        workflow.task({ name: "slow", cmd: ["slow"], deps: { fast }, cacheable: false });
      },
    });
    const heard: string[] = [];
    const store = createRunStore({
      fs: ports.fs,
      durationsFile: `${DURATIONS_DIR}/ci.ts.json`,
      listeners: [recordingListener(heard)],
    });
    const controller = new AbortController();
    const job = runJob(
      {
        implementation,
        workflowFile: "ci.ts",
        ports,
        cacheDir: CACHE_DIR,
        historyDir: HISTORY_DIR,
        store,
        signal: controller.signal,
      },
      new EventEmitter(),
    ).catch(errorMessage);
    await slowStarted.promise;
    controller.abort();
    assert.deepEqual(
      { thrown: await job, heard, lifecycle: store.getState().lifecycle },
      {
        thrown: "second build",
        heard: [
          "begin ci.ts",
          "settle fast succeeded",
          "settle slow cancelled",
          "settle release cancelled",
          "finish ci.ts",
          "close errored",
        ],
        lifecycle: { status: "errored", error: "second build" },
      },
    );
  });
});

describe("a run killed before its post pass", () => {
  test(
    "owes its posts to the next run, which pays them from the old history before any task; while one fails every try, no task runs, and the run after pays it and then runs",
    { timeout: 10_000 },
    async () => {
      const { ports, fs, rec } = testPorts();
      let pid = 0;
      let killed = true;
      let stopFails = false;
      const calls: string[] = [];
      const controller = new AbortController();
      ports.exec = {
        run: async ([program, verb, path], opts) => {
          const pidFile = opts?.env?.PID;
          calls.push(
            verb === "stop" && pidFile ? `db stop ${await fs.readText(pidFile)}` : `${program}`,
          );
          if (verb === "start" && path) await fs.writeText(path, String(++pid));
          if (program === "slow" && killed) controller.abort();
          return exited(verb === "stop" && stopFails ? 1 : 0);
        },
      };
      const { implementation } = defineWorkflow({
        implementation: (workflow) => {
          const db = workflow.task({
            name: "up:db",
            cmd: ({ out }) => ["db", "start", out.pid],
            outputs: { pid: "pid" },
            post: {
              name: "down:db",
              cmd: ["db", "stop"],
              env: ({ main }) => ({ PID: main.pid }),
            },
          });
          workflow.task({ name: "slow", cmd: ["slow"], deps: { db } });
        },
      });
      const common = { implementation, ports, cacheDir: CACHE_DIR, historyDir: HISTORY_DIR };
      /** A run of the workflow: the commands it ran, its post and start lines, and whether it failed. */
      const next = async (signal?: AbortSignal) => {
        calls.length = 0;
        rec.log.length = 0;
        const run = await runWorkflow({ ...common, ...(signal && { signal }) });
        return {
          calls: [...calls],
          lines: titlesOf(rec.log).filter((t) => t.startsWith("post ·") || t.startsWith("▷")),
          failed: run.failed,
        };
      };
      // Cancelled, then killed before its post pass, by a second Ctrl-C or a closed terminal.
      const killedRun = await next(controller.signal);
      killed = false;
      stopFails = true;
      const blocked = await next();
      stopFails = false;
      const paid = await next();
      assert.deepEqual(
        {
          killedRun,
          blocked,
          paid,
          annotations: rec.annotations,
        },
        {
          killedRun: { calls: ["db", "slow"], lines: ["▷ up:db", "▷ slow"], failed: 2 },
          // The owed post runs first, three tries, and fails: up:db and slow never start.
          blocked: {
            calls: ["db stop 1", "db stop 1", "db stop 1"],
            lines: ["post · 1 of 1 post steps owed", "▷ down:db"],
            failed: 1,
          },
          // Paid, then the run starts from nothing and releases what it set up. down:db has no
          // last run: a run whose own pass never began writes no durations.
          paid: {
            calls: ["db stop 1", "db", "slow", "db stop 2"],
            lines: [
              "post · 1 of 1 post steps owed",
              "▷ down:db",
              "▷ up:db (last run 2.0s)",
              "▷ slow",
              "▷ down:db",
            ],
            failed: 0,
          },
          annotations: [
            { level: "error", title: "down:db", message: "db stop exited 1" },
            {
              level: "error",
              title: "dag",
              message: `No task ran: post steps that an earlier run owes failed again (1), and what they release may still be there. Fix them and run again, or, once it is gone, remove that run's history in ${HISTORY_DIR}.`,
            },
          ],
        },
      );
    },
  );

  test("makes the cache dir before it pays the posts it owes, so an owed post on a fresh machine finds it", async () => {
    const { ports, fs } = testPorts();
    const events: string[] = [];
    const controller = new AbortController();
    let killed = true;
    ports.exec = {
      run: async (cmd) => {
        events.push(cmd.join(" "));
        if (cmd[0] === "e2e" && killed) controller.abort();
        return exited(0);
      },
    };
    const { ensureDir } = fs;
    ports.fs = {
      ...fs,
      ensureDir: async (path) => {
        if (path === CACHE_DIR) events.push(`made ${path}`);
        return ensureDir(path);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({
          name: "up:db",
          cmd: ["db", "start"],
          post: { name: "down:db", cmd: ["db", "stop"] },
        });
        workflow.task({ name: "e2e", cmd: ["e2e"], deps: { db }, cacheable: false });
      },
    });
    const common = { implementation, ports, cacheDir: CACHE_DIR, historyDir: HISTORY_DIR };
    await runWorkflow({ ...common, signal: controller.signal });
    killed = false;
    // A fresh machine, the history kept outside its checkout.
    await fs.remove(CACHE_DIR);
    events.length = 0;
    await runWorkflow(common);
    assert.deepEqual(events, ["made /cache", "db stop", "db start", "e2e", "db stop"]);
  });
});

describe("a history the run cannot use", () => {
  test("is ignored with a warning and removed: one that does not parse, and one whose --only names a node the workflow lacks", async () => {
    const { ports, fs, rec } = testPorts();
    const { implementation } = defineWorkflow({
      implementation: (workflow) =>
        void workflow.task({ name: "lint", cmd: ["lint"], cacheable: false }),
    });
    await fs.writeText(`${HISTORY_DIR}/damaged.json`, '{\n  "up:db": {\n    "status": "do');
    await fs.writeText(
      `${HISTORY_DIR}/gone.json`,
      JSON.stringify({ workflow: "", only: ["gone"], started: ["gone"], results: {} }),
    );
    const run = await runWorkflow({
      implementation,
      ports,
      cacheDir: CACHE_DIR,
      historyDir: HISTORY_DIR,
    });
    assert.deepEqual(
      {
        run: statusesOf(run.results),
        // The parser's own words differ between Node and Bun.
        annotations: rec.annotations.map((a) => ({
          ...a,
          message: a.message.startsWith(`ignoring the run's history ${HISTORY_DIR}/damaged.json`)
            ? a.message.split(": ")[0]
            : a.message,
        })),
        left: [...fs.files.keys()].filter((k) => k.startsWith(`${HISTORY_DIR}/`)),
      },
      {
        run: { lint: "built" },
        annotations: [
          {
            level: "warning",
            title: "dag",
            message: `ignoring the run's history ${HISTORY_DIR}/damaged.json`,
          },
          {
            level: "warning",
            title: "dag",
            message: `ignoring the run's history ${HISTORY_DIR}/gone.json: closure: the graph holds no node "gone". The post steps it owed do not run.`,
          },
        ],
        left: [],
      },
    );
  });

  test("a start the run's history cannot record fails its node not started, and the run rejects with the write's error", async () => {
    const { ports, rec } = testPorts();
    const writeText = ports.fs.writeText;
    ports.fs.writeText = (path, text) =>
      path.startsWith(`${HISTORY_DIR}/`) && text.includes('"lint"')
        ? Promise.reject(new Error("disk full"))
        : writeText(path, text);
    const store = createRunStore({
      fs: ports.fs,
      durationsFile: `${DURATIONS_DIR}/ci.ts.json`,
      listeners: [githubRenderer(ports.host)],
    });
    const { implementation } = defineWorkflow({
      implementation: (workflow) => void workflow.task({ name: "lint", cmd: ["lint"] }),
    });
    const error = await runWorkflow({
      implementation,
      workflowFile: "ci.ts",
      ports,
      cacheDir: CACHE_DIR,
      historyDir: HISTORY_DIR,
      store,
    }).catch(errorMessage);
    await store.close(error);
    assert.deepEqual(
      { error, log: rec.log, checks: rec.checks },
      {
        error: "disk full",
        log: [
          { title: "ci.ts · 1 node", lines: ["lint"] },
          "▷ lint",
          { title: "✖︎ lint (not started)", lines: ["── error ──", "disk full"] },
        ],
        checks: [
          { name: "lint", status: "in_progress", startedAt: "1970-01-01T00:00:01.000Z" },
          {
            name: "lint",
            status: "completed",
            conclusion: "failure",
            completedAt: "1970-01-01T00:00:02.000Z",
            summary: "disk full",
          },
        ],
      },
    );
  });
});

describe("a post", () => {
  test("runs after its task and every node downstream of it, through other nodes and whatever they did, and after the post of a task downstream of its own, as GitHub runs posts in the reverse order of their mains", async () => {
    const { ports } = testPorts();
    const calls: string[] = [];
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        return exited(cmd[0] === "e2e" ? 1 : 0);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const cacheDir = workflow.task({
          name: "cache-dir",
          cmd: ["cache-dir", "restore"],
          post: { name: "save", cmd: ["cache-dir", "save"] },
        });
        const db = workflow.task({
          name: "up:db",
          cmd: ["db", "start"],
          deps: { cacheDir },
          post: { name: "down:db", cmd: ["db", "stop"] },
        });
        const test = workflow.task({
          name: "test",
          cmd: ["test"],
          deps: { db },
          post: { name: "dump", cmd: ["db", "dump"] },
        });
        workflow.task({ name: "e2e", cmd: ["e2e"], deps: { test } });
      },
    });
    const { results } = await runWorkflow({
      implementation,
      ports,
      cacheDir: CACHE_DIR,
      historyDir: HISTORY_DIR,
    });
    assert.deepEqual(
      { calls, statuses: statusesOf(results) },
      {
        calls: [
          "cache-dir restore",
          "db start",
          "test",
          "e2e",
          "db dump",
          "db stop",
          "cache-dir save",
        ],
        statuses: {
          "cache-dir": "built",
          "up:db": "built",
          test: "built",
          e2e: "failed",
          dump: "built",
          "down:db": "built",
          save: "built",
        },
      },
    );
  });
});

describe("--only", () => {
  test("runs the closure of the named nodes and the posts of every main in it, each after the main's dependents in the run, whatever they did: test stops the database it shares with e2e once test settles, and up:db starts it and stops it at once", async () => {
    const { ports } = testPorts();
    const events: string[] = [];
    ports.exec = {
      run: async (cmd) => {
        events.push(`start ${cmd.join(" ")}`);
        if (cmd[0] === "test") await new Promise((r) => setTimeout(r, 50));
        events.push(`end ${cmd.join(" ")}`);
        return exited(cmd[0] === "test" ? 1 : 0);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({
          name: "up:db",
          cmd: ["db", "start"],
          post: { name: "down:db", cmd: ["db", "stop"] },
        });
        workflow.task({ name: "test", cmd: ["test"], deps: { db } });
        workflow.task({ name: "e2e", cmd: ["e2e"], deps: { db } });
      },
    });
    const runOnly = async (only: string[]) => {
      events.length = 0;
      const run = await runWorkflow({
        implementation,
        ports,
        cacheDir: CACHE_DIR,
        historyDir: HISTORY_DIR,
        only,
      });
      return { events: [...events], statuses: statusesOf(run.results) };
    };
    assert.deepEqual(
      { test: await runOnly(["test"]), db: await runOnly(["up:db"]) },
      {
        test: {
          events: [
            "start db start",
            "end db start",
            "start test",
            "end test",
            "start db stop",
            "end db stop",
          ],
          statuses: { "up:db": "built", test: "failed", "down:db": "built" },
        },
        db: {
          events: ["start db start", "end db start", "start db stop", "end db stop"],
          statuses: { "up:db": "built", "down:db": "built" },
        },
      },
    );
  });

  test("of a post runs its main with it and nothing else, and the banner says how many of the workflow's nodes it runs", async () => {
    const { ports, rec } = testPorts();
    const calls: string[] = [];
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        return exited(0);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({
          name: "up:db",
          cmd: ["db", "start"],
          post: { name: "down:db", cmd: ["db", "stop"] },
        });
        workflow.task({ name: "test", cmd: ["test"], deps: { db } });
      },
    });
    await runWorkflow({
      implementation,
      workflowFile: "ci.ts",
      ports,
      cacheDir: CACHE_DIR,
      historyDir: HISTORY_DIR,
      only: ["down:db"],
    });
    assert.deepEqual(
      { calls, banner: rec.log[0] },
      {
        calls: ["db start", "db stop"],
        banner: { title: "ci.ts · 2 of 3 nodes (--only down:db)", lines: ["up:db", "down:db"] },
      },
    );
  });

  test("of lint, which depends on a cache's restore, runs the restore, lint and the save, which saves the full key: test, which would fail, never runs", async () => {
    const service = createMemoryCacheStore();
    const { ports } = testPorts({ cacheStore: service });
    const calls: string[] = [];
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        return exited(cmd[0] === "test" ? 1 : 0);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const cacheDir = workflow.cache({
          name: "cache-dir",
          path: [".dag/cache"],
          key: "cache-dir-1",
        });
        workflow.task({ name: "lint", cmd: ["lint"], deps: { cacheDir: cacheDir.restore } });
        workflow.task({ name: "test", cmd: ["test"], deps: { cacheDir: cacheDir.restore } });
        cacheDir.save();
      },
    });
    const run = await runWorkflow({
      implementation,
      ports,
      cacheDir: CACHE_DIR,
      historyDir: HISTORY_DIR,
      only: ["lint"],
    });
    assert.deepEqual(
      { statuses: statusesOf(run.results), calls, saved: [...service.savedCaches.keys()] },
      {
        statuses: { "restore:cache-dir": "built", lint: "built", "save:cache-dir": "built" },
        calls: ["lint"],
        saved: ["cache-dir-1"],
      },
    );
  });

  test("a cancelled run's post pass runs the posts it owes over that run's selection", async () => {
    const { ports, rec } = testPorts();
    const calls: string[] = [];
    const controller = new AbortController();
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        if (cmd[0] === "e2e") controller.abort();
        return exited(0);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({
          name: "up:db",
          cmd: ["db", "start"],
          post: { name: "down:db", cmd: ["db", "stop"] },
        });
        workflow.task({ name: "e2e", cmd: ["e2e"], deps: { db } });
        workflow.task({
          name: "lint",
          cmd: ["lint"],
          post: { name: "down:lint", cmd: ["lint", "clean"] },
        });
      },
    });
    const common = {
      implementation,
      ports,
      cacheDir: CACHE_DIR,
      historyDir: HISTORY_DIR,
      only: ["e2e"],
    };
    await runWorkflow({ ...common, signal: controller.signal });
    const post = await runPost(common);
    assert.deepEqual(
      {
        banner: rec.log.find((e) => typeof e !== "string" && e.title.startsWith("post ·")),
        post: statusesOf(post.results),
        calls,
      },
      {
        // lint's post is outside the selection, so it is not among the post steps counted.
        banner: { title: "post · 1 of 1 post steps owed", lines: ["down:db"] },
        post: { "down:db": "built" },
        calls: ["db start", "e2e", "db stop"],
      },
    );
  });
});

describe("a killed --only run", () => {
  test("owes the posts of its own selection, with the deps their tasks required, to the next run of the whole workflow", async () => {
    const { ports, fs } = testPorts();
    const stopped: string[] = [];
    let pid = 0;
    let killed = true;
    const controller = new AbortController();
    ports.exec = {
      run: async ([program, verb, path], opts) => {
        if (verb === "start" && path) await fs.writeText(path, String(++pid));
        const pidFile = opts?.env?.PID;
        if (verb === "stop" && pidFile) stopped.push(await fs.readText(pidFile));
        if (program === "e2e" && killed) controller.abort();
        return exited(0);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const seed = workflow.task({ name: "seed", cmd: ["seed"], cacheable: false });
        const db = workflow.task({
          name: "up:db",
          cmd: ({ out }) => ["db", "start", out.pid],
          outputs: { pid: "pid" },
          deps: { seed },
          post: { name: "down:db", cmd: ["db", "stop"], env: ({ main }) => ({ PID: main.pid }) },
        });
        workflow.task({ name: "e2e", cmd: ["e2e"], deps: { db }, cacheable: false });
      },
    });
    const common = { implementation, ports, cacheDir: CACHE_DIR, historyDir: HISTORY_DIR };
    await runWorkflow({ ...common, only: ["e2e"], signal: controller.signal });
    killed = false;
    await runWorkflow(common);
    assert.deepEqual(stopped, ["1", "2"]);
  });
});

describe("two runs at once", () => {
  test("a run started while another runs leaves that run's posts and history alone; the post pass finishes them once it stops", async () => {
    const { ports } = testPorts();
    const events: string[] = [];
    const e2eRunning = Promise.withResolvers<void>();
    const controller = new AbortController();
    ports.exec = {
      run: async (cmd, opts) => {
        events.push(cmd.join(" "));
        if (cmd[0] === "e2e") {
          e2eRunning.resolve();
          await new Promise((r) => signalOf(opts).addEventListener("abort", r));
        }
        return exited(0);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({
          name: "up:db",
          cmd: ["db", "start"],
          post: { name: "down:db", cmd: ["db", "stop"] },
        });
        workflow.task({ name: "e2e", cmd: ["e2e"], deps: { db }, cacheable: false });
        workflow.task({ name: "lint", cmd: ["lint"], cacheable: false });
      },
    });
    const common = { implementation, ports, cacheDir: CACHE_DIR, historyDir: HISTORY_DIR };
    const first = runWorkflow({ ...common, only: ["e2e"], signal: controller.signal });
    await e2eRunning.promise;
    await runWorkflow({ ...common, only: ["lint"] });
    controller.abort();
    await first;
    await runPost(common);
    await runPost(common);
    assert.deepEqual(events, ["db start", "e2e", "lint", "db stop"]);
  });
});

describe("a history of another workflow", () => {
  test("is left for that workflow's next run, which pays it", async () => {
    const { ports } = testPorts();
    const calls: string[] = [];
    const controller = new AbortController();
    let killed = true;
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        if (cmd[0] === "check" && killed) controller.abort();
        return exited(0);
      },
    };
    const a = defineWorkflow({
      implementation: (workflow) => {
        const cacheDir = workflow.task({
          name: "restore:cache-dir",
          cmd: ["restore"],
          post: { name: "down:a", cmd: ["a", "cleanup"] },
        });
        workflow.task({ name: "check", cmd: ["check"], deps: { cacheDir }, cacheable: false });
      },
    }).implementation;
    const b = defineWorkflow({
      implementation: (workflow) => {
        workflow.task({
          name: "restore:cache-dir",
          cmd: ["restore"],
          post: { name: "save:cache-dir", cmd: ["b", "save"] },
        });
      },
    }).implementation;
    const common = { ports, cacheDir: CACHE_DIR, historyDir: HISTORY_DIR };
    await runWorkflow({
      ...common,
      implementation: a,
      workflowFile: "a.ts",
      signal: controller.signal,
    });
    killed = false;
    const ranA = calls.splice(0);
    await runWorkflow({ ...common, implementation: b, workflowFile: "b.ts" });
    const ranB = calls.splice(0);
    await runWorkflow({ ...common, implementation: a, workflowFile: "a.ts" });
    assert.deepEqual(
      { ranA, ranB, ranAgain: calls },
      {
        ranA: ["restore", "check"],
        ranB: ["restore", "b save"],
        ranAgain: ["a cleanup", "restore", "check", "a cleanup"],
      },
    );
  });
});

describe("a cache's save", () => {
  test("under a key the service refuses as invalid fails the restore, so its dependents are skipped, and tries the partial key and fails too; with partial: skip it saves nothing and succeeds", async () => {
    const run = async (partial: "save" | "skip") => {
      const { ports, rec } = testPorts();
      const asked: string[] = [];
      const invalid = (cacheKey: string) =>
        Object.assign(new Error(`Key Validation Error: ${cacheKey} cannot contain commas.`), {
          name: "ValidationError",
        });
      ports.cacheStore = {
        restore: async (_paths, cacheKey) => {
          asked.push(`restore ${cacheKey}`);
          throw invalid(cacheKey);
        },
        save: async (_paths, cacheKey) => {
          asked.push(`save ${cacheKey}`);
          throw invalid(cacheKey);
        },
      };
      const { implementation } = defineWorkflow({
        implementation: (workflow) => {
          const cacheDir = workflow.cache({
            name: "cache-dir",
            path: [".dag/cache"],
            key: "in,valid",
          });
          workflow.task({ name: "lint", cmd: ["lint"], deps: { cacheDir: cacheDir.restore } });
          cacheDir.save({ partial });
        },
      });
      const { results } = await runWorkflow({
        implementation,
        ports,
        cacheDir: CACHE_DIR,
        historyDir: HISTORY_DIR,
      });
      return {
        statuses: statusesOf(results),
        asked,
        saveLog: groupLines(rec.log, "save:cache-dir"),
      };
    };
    assert.deepEqual(
      { save: await run("save"), skip: await run("skip") },
      {
        save: {
          statuses: {
            "restore:cache-dir": "failed",
            lint: "dep-failed",
            "save:cache-dir": "failed",
          },
          asked: ["restore in,valid", "save in,valid-partial-0"],
          saveLog: [
            "── error ──",
            "Key Validation Error: in,valid-partial-0 cannot contain commas.",
          ],
        },
        skip: {
          statuses: {
            "restore:cache-dir": "failed",
            lint: "dep-failed",
            "save:cache-dir": "built",
          },
          asked: ["restore in,valid"],
          saveLog: ["Not saving cache: 2 of the run's nodes did not succeed."],
        },
      },
    );
  });

  test("a cancel landing on it stops it with the run, and nothing owes it: the post pass does not run it again", async () => {
    const controller = new AbortController();
    const service = createMemoryCacheStore();
    const { ports } = testPorts({ cacheStore: service });
    let saves = 0;
    const save = service.save;
    service.save = async (paths, cacheKey) => {
      saves++;
      controller.abort();
      return save(paths, cacheKey);
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        workflow.cache({ name: "cache-dir", path: [".dag/cache"], key: "cache-dir-1" }).save();
      },
    });
    const common = { implementation, ports, cacheDir: CACHE_DIR, historyDir: HISTORY_DIR };
    const run = await runWorkflow({ ...common, signal: controller.signal });
    const post = await runPost(common);
    assert.deepEqual(
      {
        run: statusesOf(run.results),
        post: statusesOf(post.results),
        saves,
        saved: [...service.savedCaches.keys()],
      },
      {
        run: { "restore:cache-dir": "built", "save:cache-dir": "cancelled" },
        post: {},
        saves: 1,
        saved: ["cache-dir-1"],
      },
    );
  });
});

describe("the outcome's words", () => {
  test("a failed post, a failed save and requireAll beside a failed check: each in the headline, the summary and the reproduce line, which uses the run's rerun command", async () => {
    const { ports, rec, cacheStore } = testPorts();
    ports.exec = {
      run: async (cmd, opts) => {
        opts?.onOutput?.(`${cmd[0]}\n`);
        return exited(cmd[0] === "up" ? 0 : 1, `${cmd[0]}\n`);
      },
    };
    // The save, an ordinary task, fails for its own reason after the check it waits for.
    cacheStore.save = async () => {
      throw Object.assign(new Error("Key Validation Error: k cannot contain commas."), {
        name: "ValidationError",
      });
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        workflow.cache({ name: "cache-dir", path: [".dag/cache"], key: "k" }).save();
        const db = workflow.task({
          name: "up:db",
          cmd: ["up"],
          post: { name: "down:db", cmd: ["down"], retry: "once" },
        });
        const test = workflow.task({ name: "test", cmd: ["test"], deps: { db } });
        workflow.requireAll({ deps: { test } });
      },
    });
    await runWorkflow({
      implementation,
      workflowFile: "ci.ts",
      rerunCommand: "bun run ci",
      ports,
      cacheDir: CACHE_DIR,
      historyDir: HISTORY_DIR,
    });
    assert.deepEqual(
      {
        recap: rec.log.slice(-3),
        summary: rec.summaries
          .join("")
          .split("\n")
          .find((line) => line.startsWith("### ")),
      },
      {
        recap: [
          "✖︎ test, require-all, down:db and 1 more failed · ci.ts · built 2 · cached 0 · failed 4 · skipped 0 · wall 30.0s",
          "failed: test, require-all, down:db, save:cache-dir",
          "reproduce: bun run ci --only test,require-all,down:db,save:cache-dir",
        ],
        summary: "### ✖︎ test, require-all, down:db and 1 more failed",
      },
    );
  });

  test("a reproduce line needs a rerun command, which a run without a workflow file has none of, and a post pass never draws one", async () => {
    const { ports, rec } = testPorts();
    ports.exec = { run: async (cmd) => exited(cmd[0] === "up" ? 0 : 1) };
    const { implementation } = defineWorkflow({
      implementation: (workflow) =>
        void workflow.task({
          name: "up:db",
          cmd: ["up"],
          post: { name: "down:db", cmd: ["down"], retry: "once" },
        }),
    });
    const common = { implementation, ports, cacheDir: CACHE_DIR, historyDir: HISTORY_DIR };
    await runWorkflow(common);
    const run = rec.log.splice(0).slice(-2);
    await runPost({ ...common, rerunCommand: "bun run ci" });
    assert.deepEqual(
      { run, post: rec.log.slice(-2) },
      {
        run: [
          "✖︎ down:db failed · run · built 1 · cached 0 · failed 1 · skipped 0 · wall 7.0s",
          "failed: down:db",
        ],
        post: [
          "✖︎ down:db failed · run · post · built 0 · cached 0 · failed 1 · skipped 0 · wall 1.0s",
          "failed: down:db",
        ],
      },
    );
  });
});

describe("timeoutMs", () => {
  test("a node that outlives its timeout fails as dagraph's TimeoutError, whatever its command exits with, with a timed_out check run and nothing kept under the cache dir; it is never cached, and the timeout is not in the key", async () => {
    const { ports, fs, rec, timer } = testPorts();
    let hangStarted = Promise.withResolvers<void>();
    // `hang` runs until interrupted, then exits 0 with what it printed, as a trapped SIGINT does.
    ports.exec = {
      run: (argv, opts) => {
        if (argv.at(-1) !== "hang") return okExec.run(argv, opts);
        hangStarted.resolve();
        return new Promise((resolve) =>
          signalOf(opts).addEventListener("abort", () => {
            opts?.onOutput?.("partial\n");
            resolve(exited(0, "partial\n"));
          }),
        );
      },
    };
    // Inputs make them cacheable, so the second run can hit the cache.
    const inputs = { rules: "strict" };
    const implementationFor = (lintMs: number) =>
      defineWorkflow({
        implementation: (workflow) => {
          const lint = workflow.task({ name: "lint", cmd: ["ok"], inputs, timeoutMs: lintMs });
          const test = workflow.task({
            name: "test",
            shell: "hang",
            inputs,
            deps: { lint },
            timeoutMs: 30,
          });
          workflow.task({ name: "report", cmd: ["ok"], inputs, deps: { test: settled(test) } });
        },
      }).implementation;
    /** A run whose timer the test fires once `hang` has started. */
    const run = async (lintMs: number) => {
      hangStarted = Promise.withResolvers<void>();
      const running = runWorkflow({
        implementation: implementationFor(lintMs),
        ports,
        cacheDir: CACHE_DIR,
        historyDir: HISTORY_DIR,
      });
      await hangStarted.promise;
      timer.fire();
      return running;
    };
    const first = await run(600_000);
    const second = await run(1_200_000);
    const testResult = first.results.find((result) => result.name === "test");
    const testKey = testResult && resultActionKey(testResult);
    const message = "The action 'test' has timed out after 30ms.";
    assert.deepEqual(
      {
        first: statusesOf(first.results),
        second: statusesOf(second.results),
        error: testResult?.status === "failed" && [
          testResult.error.name,
          selectors.timedOut(testResult),
        ],
        keptForTest: underCacheDir(fs).filter((path) => testKey && path.includes(testKey)),
        annotations: rec.annotations,
        checks: rec.checks
          .filter((c) => c.name === "test" && c.status === "completed")
          .map((c) => [c.conclusion, c.summary]),
        log: groupLines(rec.log, "test"),
      },
      {
        first: { lint: "built", test: "failed", report: "built" },
        second: { lint: "cached", test: "failed", report: "cached" },
        error: ["TimeoutError", true],
        keptForTest: [],
        annotations: [
          { level: "error", title: "test", message },
          { level: "error", title: "test", message },
        ],
        checks: [
          ["timed_out", message],
          ["timed_out", message],
        ],
        log: ["partial", "── error ──", message],
      },
    );
  });
});

describe("logs", () => {
  test("a hit never shows half of the log a concurrent run is printing", async () => {
    const { ports, rec } = testPorts();
    const bPrinted = Promise.withResolvers<void>();
    const bResume = Promise.withResolvers<void>();
    // Each build prints its name; B stops halfway through its line until resumed.
    let build = "A";
    ports.exec = {
      run: async (_cmd, opts) => {
        const name = build;
        opts?.onOutput?.(`${name} out`);
        if (name === "B") {
          bPrinted.resolve();
          await bResume.promise;
        }
        opts?.onOutput?.("put\n");
        return exited(0, `${name} output\n`);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) =>
        void workflow.task({ name: "x", cmd: ["x"], inputs: { version: "x-v1" } }),
    });
    const common = { implementation, ports, cacheDir: CACHE_DIR, historyDir: HISTORY_DIR };
    await runWorkflow(common);
    build = "B";
    const forced = runWorkflow({ ...common, force: true });
    await bPrinted.promise;
    await runWorkflow(common);
    bResume.resolve();
    await forced;
    await runWorkflow(common);
    assert.deepEqual(
      rec.log.flatMap((e) => (typeof e !== "string" && e.title.includes(" x (") ? [e.lines] : [])),
      [
        ["A output"],
        // A hit while B prints.
        ["A output"],
        ["B output"],
        ["B output"],
      ],
    );
  });

  test("a run writes its history, build logs and durations in the dirs it is given, each under .dag by default", async () => {
    const run = async (dirs: {
      historyDir?: string;
      buildLogDir?: string;
      durationsDir?: string;
    }) => {
      const { ports, fs } = testPorts();
      ports.exec = {
        run: async (_cmd, opts) => {
          opts?.onOutput?.("linted\n");
          return exited(0, "linted\n");
        },
      };
      const written = new Set<string>();
      const { writeText } = fs;
      ports.fs = {
        ...fs,
        writeText: (path, text) => {
          if (!path.startsWith(`${CACHE_DIR}/`)) written.add(dirname(path));
          return writeText(path, text);
        },
      };
      const { implementation } = defineWorkflow({
        implementation: (workflow) =>
          void workflow.task({ name: "lint", cmd: ["lint"], inputs: { version: "1" } }),
      });
      const { results } = await runWorkflow({
        implementation,
        workflowFile: "ci.ts",
        ports,
        cacheDir: CACHE_DIR,
        ...dirs,
      });
      const key = results[0] && resultActionKey(results[0]);
      const kept = [...fs.files.keys()].filter((k) => !k.startsWith(`${CACHE_DIR}/`));
      return {
        written: [...written],
        kept: await Promise.all(
          kept.map(async (path) => [path.replace(key ?? "", "<key>"), await fs.readText(path)]),
        ),
      };
    };
    const durations = JSON.stringify({ durations: { lint: 3000 } }, null, 2);
    assert.deepEqual(
      {
        given: await run({
          historyDir: HISTORY_DIR,
          buildLogDir: BUILD_LOG_DIR,
          durationsDir: DURATIONS_DIR,
        }),
        defaults: await run({}),
      },
      {
        given: {
          written: [HISTORY_DIR, BUILD_LOG_DIR, DURATIONS_DIR],
          kept: [
            [`${BUILD_LOG_DIR}/<key>.log`, "linted\n"],
            [`${DURATIONS_DIR}/ci.ts.json`, durations],
          ],
        },
        defaults: {
          written: [".dag/history", ".dag/build-logs", ".dag/durations"],
          kept: [
            [".dag/build-logs/<key>.log", "linted\n"],
            [".dag/durations/ci.ts.json", durations],
          ],
        },
      },
    );
  });

  test("two of every node the facade adds, that differ in their work, each have a key, a log and outputs of their own", async () => {
    // A command prints its last argument, so its log shows which command ran.
    const { ports, fs, cacheStore } = testPorts();
    ports.exec = {
      run: async (argv, opts) => {
        const output = `${argv.at(-1) ?? ""}\n`;
        opts?.onOutput?.(output);
        return exited(0, output);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        for (const x of ["a", "b"]) {
          workflow.cache({ name: x, path: [x], key: `${x}-1`, restoreKeys: [`${x}-`] }).save();
          const cmd = workflow.task({ name: `cmd:${x}`, cmd: ["echo", `cmd ${x}`] });
          workflow.task({ name: `shell:${x}`, shell: `echo shell ${x}` });
          const action = workflow.task({
            name: `action:${x}`,
            outputs: { note: "note.txt" },
            action: async ({ out, ports: p, log }) => {
              log(`action ${x}`);
              await p.fs.writeText(out.note, x);
            },
          });
          workflow.uploadArtifact({
            name: `upload:${x}`,
            artifact: x,
            deps: { action },
            path: ({ action }) => [action.note],
          });
          workflow.requireAll({ name: `require:${x}`, deps: { [x]: cmd } });
          workflow.task({
            name: `up:${x}`,
            cmd: ["echo", `up ${x}`],
            post: { name: `down:${x}`, action: ({ log }) => log(`down ${x}`) },
          });
          workflow.task({
            name: `start:${x}`,
            cmd: ["echo", `start ${x}`],
            post: { name: `stop:${x}`, cmd: ["echo", `stop ${x}`] },
          });
          workflow.task({
            name: `make:${x}`,
            cmd: ["echo", `make ${x}`],
            post: { name: `clean:${x}`, shell: `echo clean ${x}` },
          });
        }
      },
    });
    const { results } = await runWorkflow({
      implementation,
      ports,
      cacheDir: CACHE_DIR,
      historyDir: HISTORY_DIR,
      buildLogDir: BUILD_LOG_DIR,
    });
    const read = async (outputs: Outputs): Promise<unknown> =>
      typeof outputs === "string"
        ? JSON.parse(await fs.readText(outputs))
        : Object.fromEntries(
            await Promise.all(
              Object.entries(outputs).map(async ([role, path]) => [
                role,
                typeof path === "string" ? await fs.readText(path) : path,
              ]),
            ),
          );
    const nodes = Object.fromEntries(
      await Promise.all(
        results.map(async (result): Promise<[string, unknown]> => {
          const key = resultActionKey(result);
          const log = `${BUILD_LOG_DIR}/${key}.log`;
          return [
            result.name,
            {
              status: result.status,
              ownKey: results.filter((other) => resultActionKey(other) === key).length === 1,
              log: (await fs.exists(log)) ? await fs.readText(log) : null,
              outputs:
                result.status === "succeeded" ? await read(result.details.entry.outputs) : null,
            },
          ];
        }),
      ),
    );
    const node = (log: string | null, outputs: unknown) => ({
      status: "succeeded",
      ownKey: true,
      log,
      outputs,
    });
    const pair = (x: string, id: number) => ({
      [`restore:${x}`]: node(`Cache not found for input keys: ${x}-1, ${x}-\n`, {}),
      [`save:${x}`]: node(`Cache saved with key: ${x}-1\n`, { saved: "true" }),
      [`cmd:${x}`]: node(`cmd ${x}\n`, {}),
      [`shell:${x}`]: node(`echo shell ${x}\n`, {}),
      [`action:${x}`]: node(`action ${x}\n`, { note: x }),
      [`upload:${x}`]: node(
        `Artifact ${x} has been successfully uploaded! Final size is 1 bytes. Artifact ID is ${id}\n`,
        { response: JSON.stringify({ id, size: 1 }, null, 2) },
      ),
      // It printed nothing, so it keeps no log.
      [`require:${x}`]: node(null, {
        outcome: JSON.stringify({ present: [x], missing: [] }, null, 2),
      }),
      [`up:${x}`]: node(`up ${x}\n`, {}),
      [`start:${x}`]: node(`start ${x}\n`, {}),
      [`make:${x}`]: node(`make ${x}\n`, {}),
      [`down:${x}`]: node(`down ${x}\n`, {}),
      [`stop:${x}`]: node(`stop ${x}\n`, {}),
      [`clean:${x}`]: node(`echo clean ${x}\n`, {}),
    });
    assert.deepEqual(
      { nodes, saved: Object.fromEntries(cacheStore.savedCaches) },
      {
        nodes: { ...pair("a", 1), ...pair("b", 2) },
        saved: { "a-1": ["a"], "b-1": ["b"] },
      },
    );
  });
});

describe("progress", () => {
  test("a node's start line is in the log while it runs: slow cannot finish until fast, which started with it, has settled", async () => {
    const { ports, rec } = testPorts();
    const fastSettled = groupDrawn(ports, "fast");
    ports.exec = {
      run: async (cmd) => {
        if (cmd[0] === "slow") await fastSettled;
        return exited(0);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        workflow.task({ name: "slow", cmd: ["slow"], cacheable: false });
        workflow.task({ name: "fast", cmd: ["fast"], cacheable: false });
      },
    });
    await runWorkflow({ implementation, ports, cacheDir: CACHE_DIR, historyDir: HISTORY_DIR });
    assert.deepEqual(titlesOf(rec.log), [
      "2 nodes",
      "▷ slow",
      "▷ fast",
      "✔︎ fast (2.0s)",
      "✔︎ slow (6.0s)",
      "",
      "✔︎ all 2 nodes succeeded · run · built 2 · cached 0 · failed 0 · skipped 0 · wall 6.0s",
    ]);
  });
});

describe("schedulerOptions", () => {
  test("a limit the scheduler refuses fails the run before any node", async () => {
    const { ports } = testPorts();
    const calls: string[] = [];
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        return exited(0);
      },
    };
    const def = defineWorkflow({
      schedulerOptions: { concurrencyLimits: { one: 0 } },
      implementation: (workflow) =>
        void workflow.task({ name: "lint", cmd: ["lint"], concurrencyGroup: "one" }),
    });
    const error = await runWorkflow({
      ...def,
      ports,
      cacheDir: CACHE_DIR,
      historyDir: HISTORY_DIR,
    }).catch(errorMessage);
    assert.deepEqual(
      { error, calls },
      {
        error:
          "throttledScheduler: concurrencyLimits.one must be a whole number from 1, or Infinity, got 0",
        calls: [],
      },
    );
  });
});

describe("a task's time", () => {
  test("runs from its action's start, never its wait for its group's slot: in the log, the check runs, the durations file and the report the summary draws", async () => {
    let now = 0;
    const { ports, fs, rec } = testPorts({ clock: clockAt(() => now) });
    // Each command takes a second.
    ports.exec = {
      run: async () => {
        now += 1000;
        return exited(0);
      },
    };
    const def = defineWorkflow({
      schedulerOptions: { concurrencyLimits: { one: 1 } },
      summary: [
        (r) => r.nodes.map(({ node, start, duration }) => `${node.name} ${start} ${duration}`),
      ],
      implementation: (workflow) => {
        for (const name of ["a", "b", "c"])
          workflow.task({ name, cmd: [name], concurrencyGroup: "one" });
      },
    });
    assert.ok(def.schedulerOptions && def.summary, "scheduler options and summary");
    await runWorkflow({
      implementation: def.implementation,
      schedulerOptions: def.schedulerOptions,
      summary: def.summary,
      ports,
      cacheDir: CACHE_DIR,
      historyDir: HISTORY_DIR,
      durationsDir: DURATIONS_DIR,
    });
    assert.deepEqual(
      {
        groups: rec.log.flatMap((e) => (typeof e === "string" ? [] : [e.title])).slice(1),
        checks: rec.checks
          .filter((c) => c.status === "completed")
          .map((c) => [c.name, c.startedAt, c.completedAt]),
        durations: await parsed(fs, `${DURATIONS_DIR}/run.json`),
        summaries: rec.summaries,
      },
      {
        groups: ["✔︎ a (1.0s)", "✔︎ b (1.0s)", "✔︎ c (1.0s)"],
        checks: [
          ["a", "1970-01-01T00:00:00.000Z", "1970-01-01T00:00:01.000Z"],
          ["b", "1970-01-01T00:00:01.000Z", "1970-01-01T00:00:02.000Z"],
          ["c", "1970-01-01T00:00:02.000Z", "1970-01-01T00:00:03.000Z"],
        ],
        durations: { durations: { a: 1000, b: 1000, c: 1000 } },
        summaries: [["## run", "", "a 0 1000", "b 1000 1000", "c 2000 1000", ""].join("\n")],
      },
    );
  });
});

describe("the durations file", () => {
  const durationsFile = `${DURATIONS_DIR}/ci.ts.json`;

  test("a cache with no path saves the run's cache and durations dirs, this run's durations in them", async () => {
    let now = 0;
    const { ports, fs, rec } = testPorts({ clock: clockAt(() => now) });
    ports.exec = {
      run: async (cmd, opts) => {
        now += 1000;
        return okExec.run(cmd, opts);
      },
    };
    let saved: unknown;
    ports.cacheStore = {
      restore: async (_paths, cacheKey) => {
        await fs.writeText(durationsFile, JSON.stringify({ durations: { lint: 2000, old: 500 } }));
        return cacheKey;
      },
      save: async (paths) => {
        saved = { paths, file: await parsed(fs, durationsFile) };
        return true;
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const cache = workflow.cache({ key: "k" });
        workflow.task({ name: "lint", cmd: ["lint"], deps: { cache: cache.restore } });
        cache.save();
      },
    });
    await runWorkflow({
      implementation,
      workflowFile: "ci.ts",
      ports,
      cacheDir: CACHE_DIR,
      historyDir: HISTORY_DIR,
      durationsDir: DURATIONS_DIR,
    });
    assert.deepEqual(
      {
        lintStart: rec.log.find((e) => typeof e === "string" && e.startsWith("▷ lint")),
        saved,
      },
      {
        lintStart: "▷ lint (last run 2.0s)",
        saved: {
          paths: [CACHE_DIR, DURATIONS_DIR],
          file: { durations: { lint: 1000, old: 500, "restore:cache": 1 } },
        },
      },
    );
  });

  test("a run that first pays an earlier run's posts writes no durations before its restore, and still reads the one it brings", async () => {
    const { ports, fs, rec } = testPorts();
    const controller = new AbortController();
    ports.exec = {
      run: async (cmd, opts) => {
        // The first run is cancelled while slow runs, so it owes down:db.
        if (cmd[0] === "slow") controller.abort();
        return okExec.run(cmd, opts);
      },
    };
    let durationsThere: boolean | undefined;
    ports.cacheStore = {
      restore: async (_paths, cacheKey) => {
        durationsThere = await fs.exists(durationsFile);
        await fs.writeText(durationsFile, JSON.stringify({ durations: { slow: 7000 } }));
        return cacheKey;
      },
      save: async () => true,
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const cache = workflow.cache({ path: [CACHE_DIR, DURATIONS_DIR], key: "k" });
        const db = workflow.task({
          name: "up:db",
          cmd: ["db", "start"],
          post: { name: "down:db", cmd: ["db", "stop"] },
        });
        workflow.task({ name: "slow", cmd: ["slow"], deps: { cache: cache.restore, db } });
        cache.save();
      },
    });
    const run = (signal?: AbortSignal) =>
      runWorkflow({
        implementation,
        workflowFile: "ci.ts",
        ports,
        cacheDir: CACHE_DIR,
        historyDir: HISTORY_DIR,
        durationsDir: DURATIONS_DIR,
        ...(signal && { signal }),
      });
    await run(controller.signal);
    // As a clean checkout leaves it, the history kept outside it.
    await fs.remove(DURATIONS_DIR);
    ports.exec = okExec;
    await run();
    assert.deepEqual(
      {
        durationsThere,
        slowStart: rec.log.findLast((e) => typeof e === "string" && e.startsWith("▷ slow")),
      },
      { durationsThere: false, slowStart: "▷ slow (last run 7.0s)" },
    );
  });
});
