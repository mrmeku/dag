import type { NodeResult } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { STATUS_ICON } from "../kernel/index.ts";
import { clockAt, memoryRuntime } from "../memory/index.ts";
import {
  createMemoryArtifactStore,
  createMemoryCacheStore,
  createRecordingHost,
  type MemoryCacheStore,
  type RecordedHost,
} from "../recording/index.ts";
import { defineWorkflow, type Ports, type Workflow, type WorkflowDef } from "../workflow/index.ts";
import { runPost, runWorkflow } from "./index.ts";

type Exec = Ports["exec"];
type ExecResult = Awaited<ReturnType<Exec["run"]>>;
type SaveSpec = Parameters<ReturnType<Workflow["cache"]>["save"]>[0];

const CACHE_DIR = "/cache";
const HISTORY_DIR = "/state/history";
const exited = (code: number): ExecResult => ({
  ended: "exited",
  code,
  stdout: "",
  stderr: "",
  output: "",
  ok: code === 0,
});

/**
 * Ports of a memory runtime, fresh unless given, with a recording host whose context `context`
 * overrides, and memory stores.
 */
function testPorts(
  opts: {
    runtime?: ReturnType<typeof memoryRuntime>;
    cacheStore?: MemoryCacheStore;
    context?: Parameters<typeof createRecordingHost>[0];
  } = {},
) {
  const runtime = opts.runtime ?? memoryRuntime();
  const rec = createRecordingHost(opts.context);
  const ports: Ports = {
    exec: runtime.exec,
    fs: runtime.fs,
    clock: runtime.clock,
    startTimer: runtime.startTimer,
    host: rec.host,
    cacheStore: opts.cacheStore ?? createMemoryCacheStore(),
    artifactStore: createMemoryArtifactStore(),
    lockfile: runtime.lockfile,
    fileMatcher: runtime.fileMatcher,
    env: runtime.env,
  };
  return { ports, runtime, fs: runtime.fs, rec };
}

/** An `Exec` that records each command, joined, in `calls`, and exits 0. */
const recordingExec = (calls: string[]): Exec => ({
  run: async (cmd) => {
    calls.push(cmd.join(" "));
    return exited(0);
  },
});

/** How a node settled, in the words the run's output uses: built or cached, or its status. */
const outcomeOf = (result: NodeResult) =>
  result.status === "succeeded" ? (result.details.actionRan ? "built" : "cached") : result.status;
const statuses = (results: NodeResult[]) =>
  Object.fromEntries(results.map((r) => [r.name, outcomeOf(r)]));
const optionsOf = (def: WorkflowDef, ports: Ports) => ({
  implementation: def.implementation,
  ...(def.schedulerOptions && { schedulerOptions: def.schedulerOptions }),
  ports,
  cacheDir: CACHE_DIR,
  historyDir: HISTORY_DIR,
});
/** The lines of the first logged group whose title starts with `title`. */
const groupLines = (log: RecordedHost["log"], title: string) =>
  log.flatMap((e) => (typeof e !== "string" && e.title.startsWith(title) ? [e.lines] : []))[0];
/** The files left under the history dir. */
const historyFiles = (fs: ReturnType<typeof memoryRuntime>["fs"]) =>
  [...fs.files.keys()].filter((k) => k.startsWith(`${HISTORY_DIR}/`));

/** A database `test` needs, which `down:db` releases. */
const database = defineWorkflow({
  implementation: (workflow) => {
    const db = workflow.task({
      name: "up:db",
      cmd: ["compose", "up"],
      post: { name: "down:db", cmd: ["compose", "down"] },
    });
    workflow.task({ name: "test", cmd: ["test"], deps: { db } });
  },
});

/**
 * A run of `database` cancelled during `test` and killed before its post pass: it leaves a
 * stopped history owing `down:db`.
 */
async function stoppedRun(ports: Ports) {
  const controller = new AbortController();
  const exec: Exec = {
    run: async (cmd, opts) => {
      if (cmd[0] === "test") controller.abort();
      return ports.exec.run(cmd, opts);
    },
  };
  await runWorkflow({ ...optionsOf(database, { ...ports, exec }), signal: controller.signal });
}

describe("a release", () => {
  test("is owed exactly when its task started: it runs after the task failed, and after a cancel stopped it, without the outputs the task never wrote; a task that never started owes nothing", async () => {
    /** A run of `def`, cancelled when `cancelAt` is called, then its post pass. */
    const runThenPost = async (def: WorkflowDef, cancelAt?: string) => {
      const { ports, fs } = testPorts();
      const controller = new AbortController();
      const calls: string[] = [];
      let releaseEnv: Record<string, string | undefined> | undefined;
      ports.exec = {
        run: async (cmd, opts) => {
          const [program, verb, path] = cmd;
          const call = cmd.slice(0, 2).join(" ");
          calls.push(call);
          if (call === "compose down") releaseEnv = opts?.env;
          if (call === cancelAt) {
            controller.abort();
            return exited(-1);
          }
          if (program === "fail") return exited(1);
          if (program === "compose" && verb === "up" && path) await fs.writeText(path, "db-1");
          return exited(0);
        },
      };
      const options = optionsOf(def, ports);
      const run = await runWorkflow({ ...options, signal: controller.signal });
      const post = await runPost(options);
      return { run: statuses(run.results), post: statuses(post.results), calls, releaseEnv };
    };
    const failsAfterStart = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({
          name: "up:db",
          cmd: ({ out }) => ["fail", "up", out.id],
          outputs: { id: "id" },
          post: { name: "down:db", cmd: ["compose", "down"], env: ({ main }) => ({ ID: main.id }) },
        });
        workflow.task({ name: "test", cmd: ["test"], deps: { db } });
      },
    });
    const interrupted = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({
          name: "up:db",
          cmd: ({ out }) => ["compose", "up", out.id],
          outputs: { id: "id" },
          post: { name: "down:db", cmd: ["compose", "down"], env: ({ main }) => ({ ID: main.id }) },
        });
        workflow.task({ name: "test", cmd: ["test"], deps: { db } });
      },
    });
    const depFailed = defineWorkflow({
      implementation: (workflow) => {
        const prep = workflow.task({ name: "prep", cmd: ["fail"] });
        workflow.task({
          name: "up:db",
          cmd: ["compose", "up"],
          deps: { prep },
          post: { name: "down:db", cmd: ["compose", "down"] },
        });
      },
    });
    const queued = defineWorkflow({
      schedulerOptions: { concurrencyLimits: { one: 1 } },
      implementation: (workflow) => {
        workflow.task({ name: "prep", cmd: ["prep"], concurrencyGroup: "one" });
        workflow.task({
          name: "up:db",
          cmd: ["compose", "up"],
          concurrencyGroup: "one",
          post: { name: "down:db", cmd: ["compose", "down"] },
        });
      },
    });
    assert.deepEqual(
      {
        failsAfterStart: await runThenPost(failsAfterStart),
        interrupted: await runThenPost(interrupted, "compose up"),
        depFailed: await runThenPost(depFailed),
        queued: await runThenPost(queued, "prep"),
      },
      {
        // It started, so whatever it did, its release runs, with the id it never wrote unset.
        failsAfterStart: {
          run: { "up:db": "failed", test: "dep-failed", "down:db": "built" },
          post: {},
          calls: ["fail up", "compose down"],
          releaseEnv: { ID: undefined },
        },
        interrupted: {
          run: { "up:db": "cancelled", test: "cancelled", "down:db": "cancelled" },
          post: { "down:db": "built" },
          calls: ["compose up", "compose down"],
          releaseEnv: { ID: undefined },
        },
        // Its dep failed, so it never started and set nothing up.
        depFailed: {
          run: { prep: "failed", "up:db": "dep-failed", "down:db": "dep-failed" },
          post: {},
          calls: ["fail"],
          releaseEnv: undefined,
        },
        // Waiting for its group's slot when the cancel came, it never started.
        queued: {
          run: { prep: "cancelled", "up:db": "cancelled", "down:db": "cancelled" },
          post: {},
          calls: ["prep"],
          releaseEnv: undefined,
        },
      },
    );
  });

  // Checked by the typecheck: a call that does not compile fails it, as the @ts-expect-error does
  // if the call compiles.
  test("belongs to a task that is never cached, so that task takes no inputs and no cacheable; the release takes no deps, so whenever it is owed it can run", () => {
    defineWorkflow({
      implementation: (workflow) => {
        const install = workflow.task({ name: "install", cmd: ["install"] });
        workflow.task({
          name: "up:db",
          cmd: ["compose", "up"],
          deps: { install },
          post: { name: "down:db", cmd: ["compose", "down"] },
        });
        // @ts-expect-error a cache hit starts nothing, so there would be nothing to release
        workflow.task({
          name: "up:cache",
          cmd: ["cache", "up"],
          inputs: { version: "v1" },
          post: { name: "down:cache", cmd: ["cache", "down"] },
        });
        // @ts-expect-error a cache hit starts nothing, so there would be nothing to release
        workflow.task({
          name: "up:queue",
          cmd: ["queue", "up"],
          cacheable: true,
          post: { name: "down:queue", cmd: ["queue", "down"] },
        });
        workflow.task({
          name: "up:mail",
          cmd: ["mail", "up"],
          post: {
            name: "down:mail",
            cmd: ["mail", "down"],
            // @ts-expect-error what the release needs, its task depends on
            deps: { install },
          },
        });
      },
    });
  });

  test("is owed from the moment its task's command starts: the command waits until the run's history records the start", async () => {
    const { ports, fs } = testPorts();
    const calls: string[] = [];
    // The write that records up:db's start is held until the test lets it finish.
    const recording = Promise.withResolvers<void>();
    const recorded = Promise.withResolvers<void>();
    ports.fs = {
      ...fs,
      rename: async (from, to) => {
        const written = await fs.readText(from);
        if (to.startsWith(HISTORY_DIR) && written.includes('"up:db"')) {
          recording.resolve();
          await recorded.promise;
        }
        return fs.rename(from, to);
      },
    };
    ports.exec = recordingExec(calls);
    const def = defineWorkflow({
      implementation: (workflow) =>
        void workflow.task({
          name: "up:db",
          cmd: ["compose", "up"],
          post: { name: "down:db", cmd: ["compose", "down"] },
        }),
    });
    const running = runWorkflow(optionsOf(def, ports));
    await recording.promise;
    const callsWhileRecording = [...calls];
    recorded.resolve();
    await running;
    assert.deepEqual(
      { callsWhileRecording, calls },
      { callsWhileRecording: [], calls: ["compose up", "compose down"] },
    );
  });

  test("is not owed when a cancel comes before its task's command starts", async () => {
    const { ports, fs } = testPorts();
    const controller = new AbortController();
    // The cancel lands while the engine makes the task's output directory.
    ports.fs = {
      ...fs,
      ensureDir: async (path) => {
        if (path.startsWith(`${CACHE_DIR}/tmp/`)) controller.abort();
        return fs.ensureDir(path);
      },
    };
    const calls: string[] = [];
    ports.exec = recordingExec(calls);
    const def = defineWorkflow({
      implementation: (workflow) =>
        void workflow.task({
          name: "up:db",
          cmd: ["compose", "up"],
          post: { name: "down:db", cmd: ["compose", "down"] },
        }),
    });
    const options = optionsOf(def, ports);
    const run = await runWorkflow({ ...options, signal: controller.signal });
    const post = await runPost(options);
    assert.deepEqual(
      { run: statuses(run.results), post: statuses(post.results), calls },
      { run: { "up:db": "cancelled", "down:db": "cancelled" }, post: {}, calls: [] },
    );
  });
});

describe("a release that fails", () => {
  test("is tried again in its run, or once with retry: once; when every try failed it stays owed, and the next run pays it before any task and runs none while it still fails", async () => {
    /** Runs of `def` on one machine, each with `failures` more failures of the release. */
    const machine = (def: WorkflowDef, release: string) => {
      const { ports } = testPorts();
      let failures = 0;
      const calls: string[] = [];
      ports.exec = {
        run: async (cmd) => {
          const call = cmd.join(" ");
          calls.push(call);
          if (call === release && failures > 0) {
            failures--;
            return exited(1);
          }
          return exited(0);
        },
      };
      return async (releaseFailures: number) => {
        failures = releaseFailures;
        calls.length = 0;
        const run = await runWorkflow(optionsOf(def, ports));
        return { calls: [...calls], succeeded: run.failed === 0 };
      };
    };
    const db = machine(database, "compose down");
    const cloud = machine(
      defineWorkflow({
        implementation: (workflow) => {
          const up = workflow.task({
            name: "up:cloud",
            cmd: ["terraform", "apply"],
            post: { name: "down:cloud", cmd: ["terraform", "destroy"], retry: "once" },
          });
          workflow.task({ name: "e2e", cmd: ["e2e"], deps: { cloud: up } });
        },
      }),
      "terraform destroy",
    );
    assert.deepEqual(
      {
        flaky: await db(2),
        broken: await db(Infinity),
        stillBroken: await db(Infinity),
        fixed: await db(0),
        once: await cloud(1),
        onceNext: await cloud(0),
      },
      {
        // The third try succeeds.
        flaky: {
          calls: ["compose up", "test", "compose down", "compose down", "compose down"],
          succeeded: true,
        },
        // Every try fails, so the run fails and the release stays owed.
        broken: {
          calls: ["compose up", "test", "compose down", "compose down", "compose down"],
          succeeded: false,
        },
        // The owed release runs first and fails again, so no task runs.
        stillBroken: {
          calls: ["compose down", "compose down", "compose down"],
          succeeded: false,
        },
        // Paid, then the run starts from nothing and releases everything after.
        fixed: {
          calls: ["compose down", "compose up", "test", "compose down"],
          succeeded: true,
        },
        once: { calls: ["terraform apply", "e2e", "terraform destroy"], succeeded: false },
        onceNext: {
          calls: ["terraform destroy", "terraform apply", "e2e", "terraform destroy"],
          succeeded: true,
        },
      },
    );
  });

  test("is not tried again once its timeout ends during the wait between tries, and stays owed: the next post pass runs it", async () => {
    // A wait that lasts until the release's timeout aborts it.
    const waiting = Promise.withResolvers<void>();
    const runtime = memoryRuntime({
      clock: {
        epochMilliseconds: () => 0,
        sleep: (_ms, signal) => {
          waiting.resolve();
          return new Promise((resolve) => signal?.addEventListener("abort", () => resolve()));
        },
      },
    });
    const { ports } = testPorts({ runtime });
    let failing = true;
    const calls: string[] = [];
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        return exited(cmd[0] === "compose" && failing ? 1 : 0);
      },
    };
    const def = defineWorkflow({
      implementation: (workflow) =>
        void workflow.task({
          name: "up:db",
          cmd: ["up"],
          post: { name: "down:db", cmd: ["compose", "down"], timeoutMs: 500 },
        }),
    });
    const running = runWorkflow(optionsOf(def, ports));
    await waiting.promise;
    runtime.startTimer.fire();
    const run = await running;
    const runCalls = calls.splice(0);
    failing = false;
    const post = await runPost(optionsOf(def, ports));
    assert.deepEqual(
      { run: statuses(run.results), runCalls, post: statuses(post.results), postCalls: calls },
      {
        run: { "up:db": "built", "down:db": "failed" },
        runCalls: ["up", "compose down"],
        post: { "down:db": "built" },
        postCalls: ["compose down"],
      },
    );
  });

  test("is paid by the next run though the workflow file has since given its task another dep", async () => {
    const { ports } = testPorts();
    let releaseFails = true;
    const calls: string[] = [];
    ports.exec = {
      run: async (cmd) => {
        const call = cmd.join(" ");
        calls.push(call);
        return exited(call === "compose down" && releaseFails ? 1 : 0);
      },
    };
    const workflowWith = (extraDep: boolean) =>
      defineWorkflow({
        implementation: (workflow) => {
          const install = workflow.task({ name: "install", cmd: ["install"] });
          const deps = extraDep
            ? { install, build: workflow.task({ name: "build", cmd: ["build"] }) }
            : { install };
          workflow.task({
            name: "up:db",
            cmd: ["compose", "up"],
            deps,
            post: { name: "down:db", cmd: ["compose", "down"], retry: "once" },
          });
        },
      });
    await runWorkflow(optionsOf(workflowWith(false), ports));
    releaseFails = false;
    calls.length = 0;
    const next = await runWorkflow(optionsOf(workflowWith(true), ports));
    assert.deepEqual(
      { calls: calls.slice(0, 1), succeeded: next.failed === 0 },
      { calls: ["compose down"], succeeded: true },
    );
  });
});

describe("a stopped run's history", () => {
  test("whose main's result is in an older shape replays that main as cancelled, and its release still runs", async () => {
    const installed: NodeResult = {
      name: "install",
      status: "succeeded",
      details: {
        actionKey: "ki",
        entry: { outputs: {}, contentHash: "h", outputHashes: {} },
        actionRan: true,
        elapsed: 1,
      },
    };
    // up:db's result as an earlier version of dag wrote it.
    const upInAnOlderShape = {
      name: "up:db",
      actionKey: "ku",
      status: "done",
      outputs: { id: "/cache/v1/ku/h/id" },
      contentHash: "h",
      outputHashes: { id: "h" },
      elapsed: 1,
    };
    const runtime = memoryRuntime({
      files: {
        [`${HISTORY_DIR}/stopped.json`]: JSON.stringify({
          workflow: "",
          only: ["up:db"],
          started: ["install", "up:db"],
          results: { install: installed, "up:db": upInAnOlderShape },
        }),
      },
    });
    const { ports, fs } = testPorts({ runtime });
    const calls: string[] = [];
    let releaseEnv: Record<string, string | undefined> | undefined;
    ports.exec = {
      run: async (cmd, opts) => {
        calls.push(cmd.join(" "));
        releaseEnv = opts?.env;
        return exited(0);
      },
    };
    const def = defineWorkflow({
      implementation: (workflow) => {
        const install = workflow.task({ name: "install", cmd: ["install"] });
        workflow.task({
          name: "up:db",
          cmd: ({ out }) => ["compose", "up", out.id],
          deps: { install },
          outputs: { id: "id" },
          post: { name: "down:db", cmd: ["compose", "down"], env: ({ main }) => ({ ID: main.id }) },
        });
      },
    });
    const post = await runPost(optionsOf(def, ports));
    assert.deepEqual(
      { post: statuses(post.results), calls, releaseEnv, left: historyFiles(fs) },
      {
        post: { "down:db": "built" },
        calls: ["compose down"],
        // Replayed as cancelled, up:db hands its release no id.
        releaseEnv: { ID: undefined },
        left: [],
      },
    );
  });

  test("is paid once by two post passes started together: the second claimer finds it gone", async () => {
    const runtime = memoryRuntime();
    const calls: string[] = [];
    const first = testPorts({ runtime });
    first.ports.exec = recordingExec(calls);
    await stoppedRun(first.ports);
    calls.length = 0;
    const second = testPorts({ runtime });
    second.ports.exec = first.ports.exec;
    const posts = await Promise.all([
      runPost(optionsOf(database, first.ports)),
      runPost(optionsOf(database, second.ports)),
    ]);
    assert.deepEqual(
      {
        calls,
        paid: posts
          .map((post) => statuses(post.results))
          .sort((a, b) => Object.keys(b).length - Object.keys(a).length),
        left: historyFiles(runtime.fs),
      },
      { calls: ["compose down"], paid: [{ "down:db": "built" }, {}], left: [] },
    );
  });

  test("claimed by another pass between its listing and its read is skipped without a word", async () => {
    const runtime = memoryRuntime();
    const calls: string[] = [];
    const other = testPorts({ runtime });
    other.ports.exec = recordingExec(calls);
    await stoppedRun(other.ports);
    calls.length = 0;
    const { ports, rec } = testPorts({ runtime });
    ports.exec = other.ports.exec;
    let raced = false;
    ports.fs = {
      ...runtime.fs,
      readText: async (path) => {
        if (!raced && path.startsWith(`${HISTORY_DIR}/`)) {
          raced = true;
          await runPost(optionsOf(database, other.ports));
        }
        return runtime.fs.readText(path);
      },
    };
    const post = await runPost(optionsOf(database, ports));
    assert.deepEqual(
      {
        calls,
        paid: statuses(post.results),
        annotations: rec.annotations,
        left: historyFiles(runtime.fs),
      },
      { calls: ["compose down"], paid: {}, annotations: [], left: [] },
    );
  });

  test("whose release the workflow no longer declares owes nothing, and is deleted without a word or a post pass", async () => {
    const { ports, fs, rec } = testPorts();
    const calls: string[] = [];
    ports.exec = recordingExec(calls);
    await stoppedRun(ports);
    calls.length = 0;
    rec.log.length = 0;
    const released = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({ name: "up:db", cmd: ["compose", "up"] });
        workflow.task({ name: "test", cmd: ["test"], deps: { db } });
      },
    });
    await runWorkflow(optionsOf(released, ports));
    assert.deepEqual(
      { banner: rec.log[0], annotations: rec.annotations, calls, left: historyFiles(fs) },
      {
        banner: { title: "2 nodes", lines: ["up:db", "test"] },
        annotations: [],
        calls: ["compose up", "test"],
        left: [],
      },
    );
  });

  test("is left alone by a run whose --only names a node the workflow lacks: it throws before paying", async () => {
    const { ports, fs } = testPorts();
    const calls: string[] = [];
    ports.exec = recordingExec(calls);
    await stoppedRun(ports);
    calls.length = 0;
    const left = historyFiles(fs);
    await assert.rejects(runWorkflow({ ...optionsOf(database, ports), only: ["nope"] }), {
      message: 'closure: the graph holds no node "nope"',
    });
    assert.deepEqual({ calls, left: historyFiles(fs) }, { calls: [], left });
  });

  test("waits while another process, container or host holds its lock, and is paid by the next run once it is released", async () => {
    const { ports, runtime } = testPorts();
    const calls: string[] = [];
    ports.exec = recordingExec(calls);
    await stoppedRun(ports);
    const [history] = await ports.fs.readdir(HISTORY_DIR);
    // As if the run that wrote it still ran elsewhere, where its pid would mean nothing here.
    runtime.lockfile.held.add(`${HISTORY_DIR}/${history}.lock`);
    const stopped = calls.splice(0);
    await runWorkflow(optionsOf(database, ports));
    const whileHeld = calls.splice(0);
    runtime.lockfile.held.delete(`${HISTORY_DIR}/${history}.lock`);
    await runWorkflow(optionsOf(database, ports));
    assert.deepEqual(
      { stopped, whileHeld, released: calls },
      {
        stopped: ["compose up", "test"],
        whileHeld: ["compose up", "test", "compose down"],
        released: ["compose down", "compose up", "test", "compose down"],
      },
    );
  });

  test("of a run killed mid-task is skipped until its lock has gone 10 s without a refresh, then paid", async () => {
    let now = 0;
    const runtime = memoryRuntime({ clock: clockAt(() => now) });
    const { ports, fs } = testPorts({ runtime });
    const calls: string[] = [];
    const killed = Promise.withResolvers<void>();
    let kill = true;
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        if (cmd[0] !== "test" || !kill) return exited(0);
        killed.resolve();
        // Killed: the command never returns, and the run never releases its lock.
        return new Promise(() => {});
      },
    };
    void runWorkflow(optionsOf(database, ports));
    await killed.promise;
    kill = false;
    const [history = ""] = historyFiles(fs).filter((path) => path.endsWith(".json"));
    runtime.lockfile.abandon(history);
    const killedRun = calls.splice(0);
    now = 10_000;
    await runWorkflow(optionsOf(database, ports));
    const atStale = calls.splice(0);
    now = 10_001;
    await runWorkflow(optionsOf(database, ports));
    assert.deepEqual(
      { killedRun, atStale, pastStale: calls, left: historyFiles(fs) },
      {
        killedRun: ["compose up", "test"],
        atStale: ["compose up", "test", "compose down"],
        pastStale: ["compose down", "compose up", "test", "compose down"],
        left: [],
      },
    );
  });

  test("being paid when a signal comes: the owed release finishes unstopped, then every task settles cancelled unstarted, or, if the release failed again, none starts", async () => {
    /** A run cancelled while it pays the release `stoppedRun` left, which exits `releaseCode`. */
    const cancelWhilePaying = async (releaseCode: number) => {
      const { ports } = testPorts();
      const calls: string[] = [];
      ports.exec = recordingExec(calls);
      await stoppedRun(ports);
      calls.length = 0;
      const controller = new AbortController();
      let releaseStopped = false;
      ports.exec = {
        run: async (cmd, opts) => {
          calls.push(cmd.join(" "));
          controller.abort();
          releaseStopped ||= opts?.signal?.aborted ?? false;
          return exited(cmd[0] === "compose" ? releaseCode : 0);
        },
      };
      const run = await runWorkflow({ ...optionsOf(database, ports), signal: controller.signal });
      return {
        calls: [...calls],
        releaseStopped,
        run: statuses(run.results),
        cancelled: run.cancelled,
        exitCode: run.exitCode,
        owed: statuses((await runPost(optionsOf(database, ports))).results),
      };
    };
    assert.deepEqual(
      { paid: await cancelWhilePaying(0), failedAgain: await cancelWhilePaying(1) },
      {
        paid: {
          calls: ["compose down"],
          releaseStopped: false,
          run: { "up:db": "cancelled", test: "cancelled", "down:db": "cancelled" },
          cancelled: true,
          exitCode: 130,
          owed: {},
        },
        failedAgain: {
          calls: ["compose down", "compose down", "compose down"],
          releaseStopped: false,
          run: { "down:db": "failed" },
          cancelled: false,
          exitCode: 1,
          owed: { "down:db": "failed" },
        },
      },
    );
  });
});

describe("a cache's save", () => {
  test("of a run where a task failed keeps what succeeded under a partial key, which the next run restores, or nothing with partial: skip; only a green run takes the key", async () => {
    const service = createMemoryCacheStore();
    const skipping = createMemoryCacheStore();
    /** A run on a fresh machine, as CI's, with `e2e` failing if `failing`. */
    const runOnCi = async (
      runId: number,
      failing: boolean,
      on = service,
      saveSpec: SaveSpec = {},
    ) => {
      const { ports, rec } = testPorts({ cacheStore: on, context: { runId } });
      ports.exec = { run: async ([program]) => exited(program === "e2e" && failing ? 1 : 0) };
      const def = defineWorkflow({
        implementation: (workflow) => {
          const cacheDir = workflow.cache({
            name: "cache-dir",
            path: [".dag/cache"],
            key: "deps-1",
          });
          workflow.task({ name: "lint", cmd: ["lint"], deps: { cacheDir: cacheDir.restore } });
          workflow.task({ name: "e2e", cmd: ["e2e"], deps: { cacheDir: cacheDir.restore } });
          cacheDir.save(saveSpec);
        },
      });
      await runWorkflow(optionsOf(def, ports));
      return {
        restored: groupLines(rec.log, `${STATUS_ICON.succeeded} restore:cache-dir`),
        saved: [...on.savedCaches.keys()],
      };
    };
    assert.deepEqual(
      {
        failed: await runOnCi(101, true),
        green: await runOnCi(102, false),
        skipped: await runOnCi(103, true, skipping, { partial: "skip" }),
      },
      {
        failed: {
          restored: ["Cache not found for input keys: deps-1"],
          saved: ["deps-1-partial-101"],
        },
        green: {
          restored: ["Cache restored from: deps-1-partial-101"],
          saved: ["deps-1-partial-101", "deps-1"],
        },
        skipped: { restored: ["Cache not found for input keys: deps-1"], saved: [] },
      },
    );
  });
});
