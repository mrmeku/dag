import { Graph, type Result } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SaveSpec } from "./cache.ts";
import { STATUS_ICON } from "./config.ts";
import type { ExecResult, Ports } from "./ports.ts";
import { createMemoryCacheStore } from "./ports/cache-store.ts";
import { createTestPorts, type RecordedHost } from "./ports/memory.ts";
import { runPost, runWorkflow } from "./runner.ts";
import { selectNodes } from "./select.ts";
import { defineWorkflow, type WorkflowDef } from "./workflow.ts";

const CAS = "/cas";
const HISTORY_DIR = "/state/history";
const exited = (code: number): ExecResult => ({
  ended: "exited",
  code,
  stdout: "",
  stderr: "",
  output: "",
  ok: code === 0,
});
const statuses = (results: Result[]) => Object.fromEntries(results.map((r) => [r.name, r.status]));
const optionsOf = (def: WorkflowDef, ports: Ports) => ({
  implementation: def.implementation,
  ...(def.schedulerOptions && { schedulerOptions: def.schedulerOptions }),
  ports,
  casBaseDir: CAS,
  historyDir: HISTORY_DIR,
});
/** The lines of the first logged group whose title starts with `title`. */
const groupLines = (log: RecordedHost["log"], title: string) =>
  log.flatMap((e) => (typeof e !== "string" && e.title.startsWith(title) ? [e.lines] : []))[0];
const TIMEOUT = { timeout: 30_000 };

describe("a release", () => {
  test("is owed exactly when its task started: it runs after the task failed, and after a cancel stopped it, without the outputs the task never wrote; a task that never started owes nothing", async () => {
    /** A run of `def`, cancelled when `cancelAt` is called, then its post pass. */
    const runThenPost = async (def: WorkflowDef, cancelAt?: string) => {
      const { ports, fs } = createTestPorts();
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
          run: { "up:db": "failed", test: "dep-failed", "down:db": "done" },
          post: {},
          calls: ["fail up", "compose down"],
          releaseEnv: { ID: undefined },
        },
        interrupted: {
          run: { "up:db": "cancelled", test: "cancelled", "down:db": "cancelled" },
          post: { "down:db": "done" },
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
    const { ports, fs } = createTestPorts();
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
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        return exited(0);
      },
    };
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
    const { ports, fs } = createTestPorts();
    const controller = new AbortController();
    // The cancel lands while the engine makes the task's output directory.
    ports.fs = {
      ...fs,
      ensureDir: async (path) => {
        if (path.includes("/tmp-")) controller.abort();
        return fs.ensureDir(path);
      },
    };
    const calls: string[] = [];
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        return exited(0);
      },
    };
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
  test(
    "is tried again in its run, or once with retry: once; when every try failed it stays owed, and the next run pays it before any task and runs none while it still fails",
    TIMEOUT,
    async () => {
      /** Runs of `def` on one machine, each with `failures` more failures of the release. */
      const machine = (def: WorkflowDef, release: string) => {
        const { ports } = createTestPorts();
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
      const db = machine(
        defineWorkflow({
          implementation: (workflow) => {
            const up = workflow.task({
              name: "up:db",
              cmd: ["compose", "up"],
              post: { name: "down:db", cmd: ["compose", "down"] },
            });
            workflow.task({ name: "test", cmd: ["test"], deps: { db: up } });
          },
        }),
        "compose down",
      );
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
    },
  );

  test(
    "is not tried again once its timeout ends during the wait between tries",
    TIMEOUT,
    async () => {
      // A wait that lasts until the release's timeout aborts it.
      const { ports } = createTestPorts({
        clock: {
          now: () => 0,
          sleep: (_ms, signal) =>
            new Promise((resolve) => signal?.addEventListener("abort", () => resolve())),
        },
      });
      let tries = 0;
      ports.exec = {
        run: async ([program]) => {
          if (program === "compose") tries++;
          return exited(program === "compose" ? 1 : 0);
        },
      };
      const def = defineWorkflow({
        implementation: (workflow) =>
          void workflow.task({
            name: "up:db",
            cmd: ["up"],
            post: { name: "down:db", cmd: ["compose", "down"], timeoutMs: 20 },
          }),
      });
      const run = await runWorkflow(optionsOf(def, ports));
      assert.deepEqual(
        { tries, statuses: statuses(run.results) },
        {
          tries: 1,
          statuses: { "up:db": "done", "down:db": "failed" },
        },
      );
    },
  );

  test("is paid by the next run though the workflow file has since given its task another dep", async () => {
    const { ports } = createTestPorts();
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

describe("a cache's save", () => {
  test("waits, settled, for every other task of the run, also one that does not use the restore, and for no release", async () => {
    const { ports } = createTestPorts();
    const def = defineWorkflow({
      implementation: (workflow) => {
        const cas = workflow.cache({ name: "cas", path: [".dag/cas"], key: "cas-1" });
        workflow.task({ name: "build", cmd: ["build"], deps: { cas: cas.restore } });
        workflow.task({ name: "docs", cmd: ["docs"] });
        workflow.task({
          name: "up:db",
          cmd: ["compose", "up"],
          post: { name: "down:db", cmd: ["compose", "down"] },
        });
        cas.save();
      },
    });
    const graph = new Graph<Ports>();
    await def.implementation(graph, ports, await ports.host.context());
    const save = selectNodes(graph)
      .describe()
      .find((node) => node.name === "save:cas");
    assert.deepEqual(
      { deps: save?.deps.sort(), settled: save?.settledDeps?.sort() },
      {
        deps: ["build", "docs", "restore:cas", "up:db"],
        settled: ["build", "docs", "restore:cas", "up:db"],
      },
    );
  });

  test("of a run where a task failed keeps what succeeded under a partial key, which the next run restores, or nothing with partial: skip; only a green run takes the key", async () => {
    const service = createMemoryCacheStore();
    const skipping = createMemoryCacheStore();
    /** A run on a fresh machine, as CI's, with `e2e` failing if `failing`. */
    const runOnCi = async (
      runId: number,
      failing: boolean,
      on = service,
      partial: SaveSpec["partial"] = "save",
    ) => {
      const { ports, rec } = createTestPorts({ cacheStore: on, context: { runId } });
      ports.exec = { run: async ([program]) => exited(program === "e2e" && failing ? 1 : 0) };
      const def = defineWorkflow({
        implementation: (workflow) => {
          const cas = workflow.cache({ name: "cas", path: [".dag/cas"], key: "deps-1" });
          workflow.task({ name: "lint", cmd: ["lint"], deps: { cas: cas.restore } });
          workflow.task({ name: "e2e", cmd: ["e2e"], deps: { cas: cas.restore } });
          cas.save({ partial });
        },
      });
      await runWorkflow(optionsOf(def, ports));
      return {
        restored: groupLines(rec.log, `${STATUS_ICON.done} restore:cas`),
        saved: [...on.entries.keys()],
      };
    };
    assert.deepEqual(
      {
        failed: await runOnCi(101, true),
        green: await runOnCi(102, false),
        skipped: await runOnCi(103, true, skipping, "skip"),
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

  test("never runs after a cancel: the post pass runs the releases alone", async () => {
    const service = createMemoryCacheStore();
    const { ports } = createTestPorts({ cacheStore: service });
    const controller = new AbortController();
    const calls: string[] = [];
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        if (cmd[0] === "slow") {
          controller.abort();
          return exited(-1);
        }
        return exited(0);
      },
    };
    const def = defineWorkflow({
      implementation: (workflow) => {
        const cas = workflow.cache({ name: "cas", path: [".dag/cas"], key: "cas-1" });
        const db = workflow.task({
          name: "up:db",
          cmd: ["compose", "up"],
          post: { name: "down:db", cmd: ["compose", "down"] },
        });
        workflow.task({ name: "slow", cmd: ["slow"], deps: { cas: cas.restore, db } });
        cas.save();
      },
    });
    const options = optionsOf(def, ports);
    await runWorkflow({ ...options, signal: controller.signal });
    const post = await runPost(options);
    assert.deepEqual(
      { post: statuses(post.results), saved: [...service.entries.keys()], calls },
      { post: { "down:db": "done" }, saved: [], calls: ["compose up", "slow", "compose down"] },
    );
  });
});
