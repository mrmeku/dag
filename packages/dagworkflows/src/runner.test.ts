import { settled, type MemoryDagFs } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { STATUS_ICON } from "./config.ts";
import { readRunHistory } from "./history.ts";
import type { Exec } from "./ports.ts";
import { createMemoryActionsCache } from "./ports/actions-cache.ts";
import {
  clockAt,
  createMemoryLockfile,
  createTestPorts,
  okExec,
  type RecordedHost,
} from "./ports/memory.ts";
import { runJob, runPost, runWorkflow } from "./runner.ts";
import { renderStatus, renderTimeline } from "./summary.ts";
import { defineWorkflow } from "./workflow.ts";

const CAS = "/cas";

/** The lines of the first logged group whose title starts with `title`. */
const groupLines = (log: RecordedHost["log"], title: string) =>
  log.flatMap((e) => (typeof e !== "string" && e.title.startsWith(title) ? [e.lines] : []))[0];
const HISTORY_DIR = "/state/history";

/** The history files runs left in HISTORY_DIR, parsed. */
const histories = async (fs: MemoryDagFs) =>
  Promise.all(
    [...fs.files.keys()]
      .filter((k) => k.startsWith(`${HISTORY_DIR}/`) && k.endsWith(".json"))
      .map((k) => readRunHistory(fs, k)),
  );

const parsed = async (fs: MemoryDagFs, path: string): Promise<unknown> =>
  JSON.parse(await fs.readText(path));

type RunOptions = Parameters<Exec["run"]>[1];
const signalOf = (opts: RunOptions) => {
  const signal = opts?.signal;
  assert.ok(signal, "signal for the command");
  return signal;
};

describe("cancel, then post", () => {
  test("a cancelled run records what settled in its history; the post pass stops the service from that history, under the workflow's summary, and saves no cache; a second pass finds nothing", async () => {
    const controller = new AbortController();
    const calls: string[][] = [];
    const service = createMemoryActionsCache(["bun-old"]);
    const { ports, fs, rec } = createTestPorts({ actionsCache: service });
    // `db start` writes the pid it is asked for; `db stop` reads it from PID; `slow` runs until
    // the cancel interrupts it.
    let stoppedPid: string | undefined;
    const exec: Exec = {
      run: async (cmd, opts) => {
        calls.push(cmd);
        const [program, verb, path] = cmd;
        if (program === "db" && verb === "start" && path) await fs.writeText(path, "7");
        const pidFile = opts?.env?.PID;
        if (program === "db" && verb === "stop" && pidFile) stoppedPid = await fs.readText(pidFile);
        if (program !== "slow") return { code: 0, stdout: "", stderr: "", output: "", ok: true };
        return new Promise((resolve) =>
          signalOf(opts).addEventListener("abort", () =>
            resolve({
              code: -1,
              stdout: "",
              stderr: "killed by SIGINT\n",
              output: "killed by SIGINT\n",
              ok: false,
            }),
          ),
        );
      },
    };
    ports.exec = exec;
    const def = defineWorkflow({
      summary: [(r) => r.nodes.map((n) => `${n.name} ${n.status}`)],
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
      casBaseDir: CAS,
      historyDir: HISTORY_DIR,
    };
    const fastSettled = new Promise<void>((resolve) => {
      const group = ports.host.group;
      ports.host.group = (title, lines) => {
        group(title, lines);
        if (title.startsWith("✔\uFE0E fast")) resolve();
      };
    });
    const running = runWorkflow({ ...common, signal: controller.signal });
    await fastSettled;
    controller.abort();
    const run = await running;
    const recorded = (await histories(fs)).map((j) => j.results);
    const post = await runPost(common);
    const again = await runPost(common);
    const status = (rs: { name: string; status: string }[]) =>
      Object.fromEntries(rs.map((r) => [r.name, r.status]));
    assert.deepEqual(
      {
        run: { cancelled: run.cancelled, failed: run.failed, statuses: status(run.results) },
        recorded,
        post: status(post.results),
        again: status(again.results),
        calls: calls.map((c) => c.slice(0, 2)),
        stoppedPid,
        saved: [...service.entries.keys()],
        headersStartsAndRecaps: rec.log
          .map((e) => (typeof e === "string" ? e : e.title))
          .filter((t) => /^(\d+ nodes|post · |▷ )/.test(t) || t.includes(" · built ")),
        summaries: rec.summaries,
        slowLog: groupLines(rec.log, `${STATUS_ICON.cancelled} slow`),
      },
      {
        run: {
          cancelled: true,
          failed: 4,
          statuses: {
            "restore:bun": "done",
            "up:db": "done",
            fast: "done",
            slow: "cancelled",
            after: "cancelled",
            "save:bun": "cancelled",
            "down:db": "cancelled",
          },
        },
        // Each node's whole result, as the run settled it.
        recorded: [Object.fromEntries(run.results.map((r) => [r.name, r]))],
        // A save is ordinary work: the cancel stopped it, and nothing owes it.
        post: { "down:db": "done" },
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
          "◼\uFE0E cancelled, 4 nodes not run · run · built 3 · cached 0 · failed 0 · skipped 0 · cancelled 4 · wall 9.0s",
          "post · 1 of 1 post steps owed",
          "▷ down:db",
          "✔\uFE0E 1 node succeeded · run · post · built 1 · cached 0 · failed 0 · skipped 0 · wall 1.0s",
        ],
        // The workflow's own section, in both passes; the post pass draws its owed steps alone.
        summaries: [
          [
            "## run",
            "",
            "restore:bun done",
            "up:db done",
            "fast done",
            "slow cancelled",
            "after cancelled",
            "down:db cancelled",
            "save:bun cancelled",
            "",
          ].join("\n"),
          ["## run · post", "", "down:db done", ""].join("\n"),
        ],
        slowLog: ["killed by SIGINT"],
      },
    );
  });
});

describe("runJob", () => {
  test("after a cancel, the same process runs the post steps owed in the run's selection, a selected task's post included, under its title and summary, and exits 130", async () => {
    const controller = new AbortController();
    const { ports, rec } = createTestPorts();
    const fastSettled = new Promise<void>((resolve) => {
      const group = ports.host.group;
      ports.host.group = (title, lines) => {
        group(title, lines);
        if (title.startsWith("✔\uFE0E fast")) resolve();
      };
    });
    ports.exec = {
      run: async (cmd, opts) => {
        if (cmd[0] !== "slow") return { code: 0, stdout: "", stderr: "", output: "", ok: true };
        return new Promise((resolve) =>
          signalOf(opts).addEventListener("abort", () =>
            resolve({ code: -1, stdout: "", stderr: "", output: "", ok: false }),
          ),
        );
      },
    };
    const def = defineWorkflow({
      summary: [(r) => r.nodes.map((n) => `${n.name} ${n.status}`)],
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
    const job = runJob(
      {
        implementation: def.implementation,
        workflowFile: "ci.ts",
        summary: def.summary,
        ports,
        casBaseDir: CAS,
        historyDir: HISTORY_DIR,
        only: ["slow"],
        signal: controller.signal,
      },
      new EventEmitter(),
    );
    await fastSettled;
    controller.abort();
    assert.deepEqual(
      { code: await job, log: rec.log, summaries: rec.summaries },
      {
        code: 130,
        // lint is outside the selection; slow's dep fast is in it, and so is fast's post.
        log: [
          { title: "ci.ts · 3 of 4 nodes (--only slow)", lines: ["fast", "slow", "notify"] },
          "▷ fast",
          { title: "✔\uFE0E fast (1.0s)", lines: [] },
          "▷ slow",
          { title: "◼\uFE0E slow (cancelled)", lines: [] },
          "◼\uFE0E notify: cancelled",
          "",
          "◼\uFE0E cancelled, 2 nodes not run · ci.ts · built 1 · cached 0 · failed 0 · skipped 0 · cancelled 2 · wall 4.0s",
          "cancelled: slow, notify",
          { title: "post · 1 of 1 post steps owed", lines: ["notify"] },
          "▷ notify",
          { title: "✔\uFE0E notify (1.0s)", lines: [] },
          "",
          "✔\uFE0E 1 node succeeded · ci.ts · post · built 1 · cached 0 · failed 0 · skipped 0 · wall 1.0s",
        ],
        summaries: [
          ["## ci.ts", "", "fast done", "slow cancelled", "notify cancelled", ""].join("\n"),
          ["## ci.ts · post", "", "notify done", ""].join("\n"),
        ],
      },
    );
  });
});

describe("a run killed before its post pass", () => {
  test(
    "owes its posts to the next run, which pays them from the old history before any task; while one fails every try, no task runs, and the run after pays it and then runs",
    { timeout: 10_000 },
    async () => {
      const { ports, fs, rec } = createTestPorts();
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
          const ok = verb !== "stop" || !stopFails;
          return { code: ok ? 0 : 1, stdout: "", stderr: "", output: "", ok };
        },
      };
      const implementation = defineWorkflow({
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
      }).implementation;
      const common = { implementation, ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
      /** A run of the workflow: the commands it ran, its post and start lines, and whether it failed. */
      const next = async (signal?: AbortSignal) => {
        calls.length = 0;
        rec.log.length = 0;
        const run = await runWorkflow({ ...common, ...(signal && { signal }) });
        return {
          calls: [...calls],
          lines: rec.log
            .map((e) => (typeof e === "string" ? e : e.title))
            .filter((t) => t.startsWith("post ·") || t.startsWith("▷")),
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
          annotations: rec.annotations.map(({ level, title }) => ({ level, title })),
        },
        {
          killedRun: { calls: ["db", "slow"], lines: ["▷ up:db", "▷ slow"], failed: 2 },
          // The owed post runs first, three tries, and fails: up:db and slow never start.
          blocked: {
            calls: ["db stop 1", "db stop 1", "db stop 1"],
            lines: ["post · 1 of 1 post steps owed", "▷ down:db"],
            failed: 1,
          },
          // Paid, then the run starts from nothing and releases what it set up.
          paid: {
            calls: ["db stop 1", "db", "slow", "db stop 2"],
            lines: [
              "post · 1 of 1 post steps owed",
              "▷ down:db",
              "▷ up:db (last run 1.0s)",
              "▷ slow",
              "▷ down:db (last run 1.0s)",
            ],
            failed: 0,
          },
          annotations: [
            { level: "error", title: "down:db" },
            { level: "error", title: "dag" },
          ],
        },
      );
    },
  );
});

describe("a damaged history", () => {
  test("is never left by a write that stops halfway, and one found anyway is ignored with a warning", async () => {
    const { ports, fs, rec } = createTestPorts();
    const halfWritten = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let stall = true;
    ports.fs = {
      ...fs,
      writeText: async (path, content) => {
        if (!stall || !path.startsWith(`${HISTORY_DIR}/`) || !content.includes('"lint"'))
          return fs.writeText(path, content);
        await fs.writeText(path, content.slice(0, content.length / 2));
        halfWritten.resolve();
        await resume.promise;
        stall = false;
        await fs.writeText(path, content);
      },
    };
    const implementation = defineWorkflow({
      implementation: (workflow) =>
        void workflow.task({ name: "lint", cmd: ["lint"], cacheable: false }),
    }).implementation;
    const common = { implementation, ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
    const running = runWorkflow(common);
    await halfWritten.promise;
    const midWrite = await histories(fs);
    resume.resolve();
    await running;
    await fs.writeText(`${HISTORY_DIR}/damaged.json`, '{\n  "up:db": {\n    "status": "do');
    const after = await runWorkflow(common);
    assert.deepEqual(
      {
        midWrite,
        after: after.results.map((r) => [r.name, r.status]),
        // The parser's own words differ between Node and Bun.
        annotations: rec.annotations.map((a) => ({ ...a, message: a.message.split(": ")[0] })),
        left: [...fs.files.keys()].filter((k) => k.startsWith(HISTORY_DIR)),
      },
      {
        midWrite: [{ workflow: "", started: [], results: {} }],
        after: [["lint", "done"]],
        annotations: [
          {
            level: "warning",
            title: "dag",
            message: `ignoring the run's history ${HISTORY_DIR}/damaged.json`,
          },
        ],
        left: [],
      },
    );
  });
});

describe("--only", () => {
  test("runs the closure of the named nodes and the posts of every main in it, each after the main's dependents in the run, whatever they did: test stops the database it shares with e2e once test settles, and up:db starts it and stops it at once", async () => {
    const { ports } = createTestPorts();
    const events: string[] = [];
    ports.exec = {
      run: async (cmd) => {
        events.push(`start ${cmd.join(" ")}`);
        if (cmd[0] === "test") await new Promise((r) => setTimeout(r, 50));
        events.push(`end ${cmd.join(" ")}`);
        const ok = cmd[0] !== "test";
        return { code: ok ? 0 : 1, stdout: "", stderr: "", output: "", ok };
      },
    };
    const implementation = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({
          name: "up:db",
          cmd: ["db", "start"],
          post: { name: "down:db", cmd: ["db", "stop"] },
        });
        workflow.task({ name: "test", cmd: ["test"], deps: { db } });
        workflow.task({ name: "e2e", cmd: ["e2e"], deps: { db } });
      },
    }).implementation;
    const runOnly = async (only: string[]) => {
      events.length = 0;
      const run = await runWorkflow({
        implementation,
        ports,
        casBaseDir: CAS,
        historyDir: HISTORY_DIR,
        only,
      });
      return {
        events: [...events],
        statuses: Object.fromEntries(run.results.map((r) => [r.name, r.status])),
      };
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
          statuses: { "up:db": "done", test: "failed", "down:db": "done" },
        },
        db: {
          events: ["start db start", "end db start", "start db stop", "end db stop"],
          statuses: { "up:db": "done", "down:db": "done" },
        },
      },
    );
  });

  test("saves the CAS after lint alone when lint depends on its restore: the save waits for every node of the selection", async () => {
    const service = createMemoryActionsCache();
    const { ports } = createTestPorts({ actionsCache: service });
    const events: string[] = [];
    ports.exec = {
      run: async (cmd) => {
        events.push(`start ${cmd[0]}`);
        await new Promise((r) => setTimeout(r, 50));
        events.push(`end ${cmd[0]}`);
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const save = service.saveCache;
    service.saveCache = async (paths, key) => (events.push(`save ${key}`), save(paths, key));
    const implementation = defineWorkflow({
      implementation: (workflow) => {
        const cas = workflow.cache({ name: "cas", path: [".dag/cas"], key: "cas-1" });
        workflow.task({ name: "lint", cmd: ["lint"], deps: { cas: cas.restore } });
        workflow.task({ name: "test", cmd: ["test"], deps: { cas: cas.restore } });
        cas.save();
      },
    }).implementation;
    const run = await runWorkflow({
      implementation,
      ports,
      casBaseDir: CAS,
      historyDir: HISTORY_DIR,
      only: ["lint"],
    });
    assert.deepEqual(
      { events, statuses: Object.fromEntries(run.results.map((r) => [r.name, r.status])) },
      {
        events: ["start lint", "end lint", "save cas-1"],
        statuses: { "restore:cas": "done", lint: "done", "save:cas": "done" },
      },
    );
  });

  test("a cancelled run's post pass runs the posts it owes over that run's selection", async () => {
    const { ports } = createTestPorts();
    const calls: string[] = [];
    const controller = new AbortController();
    let cancelAtE2e = false;
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        if (cmd[0] === "e2e" && cancelAtE2e) controller.abort();
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const implementation = defineWorkflow({
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
    }).implementation;
    const common = {
      implementation,
      ports,
      casBaseDir: CAS,
      historyDir: HISTORY_DIR,
      only: ["e2e"],
    };
    const run = await runWorkflow(common);
    const ran = calls.splice(0);
    cancelAtE2e = true;
    const cancelled = await runWorkflow({ ...common, signal: controller.signal });
    const post = await runPost(common);
    const status = (rs: { name: string; status: string }[]) =>
      Object.fromEntries(rs.map((r) => [r.name, r.status]));
    assert.deepEqual(
      {
        ran,
        statuses: status(run.results),
        cancelled: status(cancelled.results),
        post: status(post.results),
        calls,
      },
      {
        ran: ["db start", "e2e", "db stop"],
        statuses: { "up:db": "done", e2e: "done", "down:db": "done" },
        cancelled: { "up:db": "done", e2e: "cancelled", "down:db": "cancelled" },
        post: { "down:db": "done" },
        calls: ["db start", "e2e", "db stop"],
      },
    );
  });
});

describe("two runs at once", () => {
  test("a run started while another runs leaves that run's posts and history alone; the post pass finishes them once it stops", async () => {
    const { ports } = createTestPorts();
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
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const implementation = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({
          name: "up:db",
          cmd: ["db", "start"],
          post: { name: "down:db", cmd: ["db", "stop"] },
        });
        workflow.task({ name: "e2e", cmd: ["e2e"], deps: { db }, cacheable: false });
        workflow.task({ name: "lint", cmd: ["lint"], cacheable: false });
      },
    }).implementation;
    const common = { implementation, ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
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

describe("a history's lock", () => {
  test("keeps a stopped run's history waiting while another process, container or host holds it, and the next run once it is released settles the posts", async () => {
    const { ports } = createTestPorts();
    const lockfile = createMemoryLockfile();
    ports.lockfile = lockfile;
    const calls: string[] = [];
    const controller = new AbortController();
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        if (cmd[0] === "e2e") controller.abort();
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const implementation = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({
          name: "up:db",
          cmd: ["db", "start"],
          post: { name: "down:db", cmd: ["db", "stop"] },
        });
        workflow.task({ name: "e2e", cmd: ["e2e"], deps: { db }, cacheable: false });
      },
    }).implementation;
    const common = { implementation, ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
    // Cancelled, then killed before its post pass.
    await runWorkflow({ ...common, signal: controller.signal });
    const [history] = await ports.fs.readdir(HISTORY_DIR);
    // As if the run that wrote it still ran elsewhere, where its pid would mean nothing here.
    lockfile.held.add(`${HISTORY_DIR}/${history}.lock`);
    const whileHeld = calls.splice(0);
    await runWorkflow(common);
    const heldRun = calls.splice(0);
    lockfile.held.delete(`${HISTORY_DIR}/${history}.lock`);
    await runWorkflow(common);
    assert.deepEqual(
      { whileHeld, heldRun, released: calls },
      {
        whileHeld: ["db start", "e2e"],
        heldRun: ["db start", "e2e", "db stop"],
        released: ["db stop", "db start", "e2e", "db stop"],
      },
    );
  });
});

describe("a history of another workflow", () => {
  test("is left for that workflow's next run, which settles it", async () => {
    const { ports } = createTestPorts();
    const calls: string[] = [];
    const controller = new AbortController();
    let killed = true;
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        if (cmd[0] === "check" && killed) controller.abort();
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const a = defineWorkflow({
      implementation: (workflow) => {
        const cas = workflow.task({
          name: "restore:cas",
          cmd: ["restore"],
          post: { name: "down:a", cmd: ["a", "cleanup"] },
        });
        workflow.task({ name: "check", cmd: ["check"], deps: { cas }, cacheable: false });
      },
    }).implementation;
    const b = defineWorkflow({
      implementation: (workflow) => {
        workflow.task({
          name: "restore:cas",
          cmd: ["restore"],
          post: { name: "save:cas", cmd: ["b", "save"] },
        });
      },
    }).implementation;
    const common = { ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
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

describe("a killed --only run", () => {
  test("owes the posts of its own selection, with the deps their tasks required, to the next run of the whole workflow", async () => {
    const { ports, fs } = createTestPorts();
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
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const implementation = defineWorkflow({
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
    }).implementation;
    const common = { implementation, ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
    await runWorkflow({ ...common, only: ["e2e"], signal: controller.signal });
    killed = false;
    await runWorkflow(common);
    assert.deepEqual(stopped, ["1", "2"]);
  });
});

describe("logs", () => {
  test("a run never shows half of the log a concurrent run of the same node is writing", async () => {
    const { ports, fs, rec } = createTestPorts();
    const aWrote = Promise.withResolvers<void>();
    const bHalf = Promise.withResolvers<void>();
    const bResume = Promise.withResolvers<void>();
    let execs = 0;
    let logs = 0;
    // Run A puts its log in place first; then B's log write stops halfway while A's reporter reads.
    ports.exec = {
      run: async () => {
        const run = ++execs === 1 ? "A" : "B";
        if (run === "B") await aWrote.promise;
        return { code: 0, stdout: "", stderr: "", output: `${run} output\n`, ok: true };
      },
    };
    ports.fs = {
      ...fs,
      writeText: async (path, content) => {
        if (content === "B output\n") {
          await fs.writeText(path, content.slice(0, 4));
          bHalf.resolve();
          await bResume.promise;
        }
        return fs.writeText(path, content);
      },
      rename: async (from, to) => {
        await fs.rename(from, to);
        if (to.endsWith(".log") && ++logs === 1) {
          aWrote.resolve();
          await bHalf.promise;
        }
      },
    };
    const implementation = defineWorkflow({
      implementation: (workflow) => void workflow.task({ name: "x", cmd: ["x"], cacheable: false }),
    }).implementation;
    const common = { implementation, ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
    const runs = [runWorkflow(common), runWorkflow(common)];
    await Promise.race(runs);
    bResume.resolve();
    await Promise.all(runs);
    assert.deepEqual(groupLines(rec.log, `${STATUS_ICON.done} x`), ["A output"]);
  });
});

describe("progress", () => {
  test("a node's start line is in the log while it runs: slow cannot finish until fast, which started with it, has settled", async () => {
    const { ports, rec } = createTestPorts();
    const fastSettled = new Promise<void>((resolve) => {
      const group = ports.host.group;
      ports.host.group = (title, lines) => {
        group(title, lines);
        if (title.startsWith("✔\uFE0E fast")) resolve();
      };
    });
    ports.exec = {
      run: async (cmd) => {
        if (cmd[0] === "slow") await fastSettled;
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const def = defineWorkflow({
      implementation: (workflow) => {
        workflow.task({ name: "slow", cmd: ["slow"], cacheable: false });
        workflow.task({ name: "fast", cmd: ["fast"], cacheable: false });
      },
    });
    await runWorkflow({
      implementation: def.implementation,
      ports,
      casBaseDir: CAS,
      historyDir: HISTORY_DIR,
    });
    assert.deepEqual(
      rec.log.map((e) => (typeof e === "string" ? e : e.title)),
      [
        "2 nodes",
        "▷ slow",
        "▷ fast",
        "✔\uFE0E fast (1.0s)",
        "✔\uFE0E slow (3.0s)",
        "",
        "✔\uFE0E all 2 nodes succeeded · run · built 2 · cached 0 · failed 0 · skipped 0 · wall 3.0s",
      ],
    );
  });
});

describe("a step's time", () => {
  test("runs from its action's start, never its wait for its group's slot: in the log, the check runs, last-run.json, the timeline and the parallelism", async () => {
    let now = 0;
    const { ports, fs, rec } = createTestPorts({
      clock: clockAt(() => now),
    });
    // Each command takes a second.
    ports.exec = {
      run: async () => {
        now += 1000;
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const def = defineWorkflow({
      schedulerOptions: { concurrencyLimits: { one: 1 } },
      summary: [renderStatus, renderTimeline],
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
      casBaseDir: CAS,
      historyDir: HISTORY_DIR,
    });
    assert.deepEqual(
      {
        groups: rec.log.flatMap((e) => (typeof e === "string" ? [] : [e.title])).slice(1),
        checks: rec.checks
          .filter((c) => c.status === "completed")
          .map((c) => [c.name, c.startedAt, c.completedAt]),
        lastRun: await parsed(fs, `${CAS}/last-run.json`),
        summary: rec.summaries,
      },
      {
        groups: ["✔\uFE0E a (1.0s)", "✔\uFE0E b (1.0s)", "✔\uFE0E c (1.0s)"],
        checks: [
          ["a", "1970-01-01T00:00:00.000Z", "1970-01-01T00:00:01.000Z"],
          ["b", "1970-01-01T00:00:01.000Z", "1970-01-01T00:00:02.000Z"],
          ["c", "1970-01-01T00:00:02.000Z", "1970-01-01T00:00:03.000Z"],
        ],
        lastRun: { durations: { a: 1000, b: 1000, c: 1000 } },
        summary: [
          [
            "## run",
            "",
            "### ✔\uFE0E all 3 nodes succeeded",
            "",
            "built **3** · cached **0** · failed **0** · skipped **0** · wall 3.0s · parallelism 1.0× · cache 0/3 hits",
            "",
            "```mermaid",
            "gantt",
            "  title node timeline",
            "  dateFormat x",
            "  axisFormat %M:%S",
            "  section nodes",
            "  a :done, 0, 1000",
            "  b :done, 1000, 2000",
            "  c :done, 2000, 3000",
            "```",
            "",
          ].join("\n"),
        ],
      },
    );
  });
});

describe("cancel during a save", () => {
  test("a save the cancel lands on is stopped with the run, and nothing owes it: the post pass does not run it again", async () => {
    const controller = new AbortController();
    const service = createMemoryActionsCache();
    const { ports } = createTestPorts({ actionsCache: service });
    let saves = 0;
    const save = service.saveCache;
    service.saveCache = async (paths, key) => {
      saves++;
      controller.abort();
      return save(paths, key);
    };
    const implementation = defineWorkflow({
      implementation: (workflow) => {
        workflow.cache({ name: "cas", path: [".cas"], key: "cas-1" }).save();
      },
    }).implementation;
    const common = { implementation, ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
    const run = await runWorkflow({ ...common, signal: controller.signal });
    const post = await runPost(common);
    const status = (rs: { name: string; status: string }[]) =>
      Object.fromEntries(rs.map((r) => [r.name, r.status]));
    assert.deepEqual(
      {
        run: status(run.results),
        post: status(post.results),
        saves,
        saved: [...service.entries.keys()],
      },
      {
        run: { "restore:cas": "done", "save:cas": "cancelled" },
        post: {},
        saves: 1,
        saved: ["cas-1"],
      },
    );
  });
});

describe("timeoutMs", () => {
  test("a step that outlives its timeout fails in the runner's words with a timed_out check, whatever it exits with; it is never cached, and the timeout is not in the key", async () => {
    const { ports, rec } = createTestPorts();
    // `hang` runs until interrupted, then exits 0 with what it printed, as a trapped SIGINT does.
    ports.exec = {
      run: (cmd, opts) =>
        cmd[0] === "hang"
          ? new Promise((resolve) =>
              signalOf(opts).addEventListener("abort", () =>
                resolve({
                  code: 0,
                  stdout: "partial\n",
                  stderr: "",
                  output: "partial\n",
                  ok: true,
                }),
              ),
            )
          : okExec.run(cmd, opts),
    };
    // Inputs make them cacheable, so the second run can hit the cache.
    const inputs = { rules: "strict" };
    const implementationFor = (lintMs: number) =>
      defineWorkflow({
        implementation: (workflow) => {
          const test = workflow.task({ name: "test", cmd: ["hang"], inputs, timeoutMs: 30 });
          workflow.task({ name: "lint", cmd: ["ok"], inputs, timeoutMs: lintMs });
          workflow.task({ name: "report", cmd: ["ok"], inputs, deps: { test: settled(test) } });
        },
      }).implementation;
    const common = { ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
    const first = await runWorkflow({ ...common, implementation: implementationFor(600_000) });
    const second = await runWorkflow({ ...common, implementation: implementationFor(1_200_000) });
    const status = (rs: { name: string; status: string }[]) =>
      Object.fromEntries(rs.map((r) => [r.name, r.status]));
    const message = "The action 'test' has timed out after 30ms.";
    assert.deepEqual(
      {
        first: status(first.results),
        second: status(second.results),
        annotations: rec.annotations,
        checks: rec.checks
          .filter((c) => c.name === "test" && c.status === "completed")
          .map((c) => [c.conclusion, c.summary]),
        log: groupLines(rec.log, `${STATUS_ICON.failed} test`),
      },
      {
        first: { test: "failed", lint: "done", report: "done" },
        second: { test: "failed", lint: "cached", report: "cached" },
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

describe("secrets", () => {
  test("a command inherits the whole environment, on GitHub the runner's credentials and the action's inputs too; nothing a command prints lands in the CAS", async () => {
    const env = {
      NPM_TOKEN: "npm-s3cret",
      GITHUB_TOKEN: "ghs-token",
      ACTIONS_RUNTIME_TOKEN: "runtime-token",
      INPUT_WORKFLOW: "scripts/ci.ts",
      GITHUB_ACTIONS: "true",
    };
    const { ports, fs } = createTestPorts({ env });
    const seen: Array<Record<string, string | undefined> | undefined> = [];
    ports.exec = {
      run: async (_cmd, opts) => {
        seen.push(opts?.env);
        const output = "token npm-s3cret\n";
        return { code: 0, stdout: output, stderr: "", output, ok: true };
      },
    };
    const implementation = defineWorkflow({
      implementation: (workflow) => void workflow.task({ name: "publish", cmd: ["publish"] }),
    }).implementation;
    await runWorkflow({ implementation, ports, casBaseDir: CAS, historyDir: HISTORY_DIR });
    const inCas = [...fs.files]
      .filter(([path, data]) => path.startsWith(`${CAS}/`) && String(data).includes("s3cret"))
      .map(([path]) => path);
    // createExec merges what the step sets over process.env, so nothing set here is inherited.
    assert.deepEqual({ seen, inCas }, { seen: [{}], inCas: [] });
  });
});
