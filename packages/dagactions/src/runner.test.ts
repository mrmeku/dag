import { Graph } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { STATUS_ICON } from "./config.ts";
import { readJournal } from "./journal.ts";
import type { Sh } from "./ports.ts";
import { createMemoryActionsCache } from "./ports/actions-cache.ts";
import { createTestPorts, okSh, type RecordedCi } from "./ports/memory.ts";
import { runJob, runPost, runWorkflow } from "./runner.ts";
import { createSteps, defineWorkflow } from "./workflow.ts";

const CAS = "/cas";

/** The lines of the first logged group whose title starts with `title`. */
const groupLines = (log: RecordedCi["log"], title: string) =>
  log.flatMap((e) => (typeof e !== "string" && e.title.startsWith(title) ? [e.lines] : []))[0];
const JOURNAL = "/state/journal.json";

describe("cancel, then post", () => {
  test("a cancelled run journals what settled; the post pass saves the cache and stops the service from the journal, under the workflow's summary; a second pass finds nothing", async () => {
    const controller = new AbortController();
    const calls: string[][] = [];
    const service = createMemoryActionsCache(["bun-old"]);
    const { ports, fs, rec } = createTestPorts({ actionsCache: service });
    // `db start` writes the pid it is asked for; `slow` runs until the cancel interrupts it.
    const sh: Sh = {
      run: async (cmd, opts) => {
        calls.push(cmd);
        if (cmd[0] === "db" && cmd[1] === "start")
          await fs.writeText(`${opts!.env!.DAGACTIONS_OUT}/pid`, "7");
        if (cmd[0] !== "slow") return { code: 0, stdout: "", stderr: "", output: "", ok: true };
        return new Promise((resolve) =>
          opts!.signal!.addEventListener("abort", () =>
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
    ports.sh = sh;
    const workflow = defineWorkflow({
      summary: [(r) => r.nodes.map((n) => `${n.name} ${n.status}`)],
      build: (w) => {
        const bun = w.restoreCache({
          name: "restore:bun",
          path: ["~/.bun"],
          key: "bun-new",
          restoreKeys: ["bun-"],
        });
        const db = w.run({
          name: "up:db",
          cmd: ["db", "start"],
          outputs: { pid: "pid" },
          cacheable: false,
        });
        const fast = w.run({ name: "fast", cmd: ["fast"], deps: { bun, db }, cacheable: false });
        const slow = w.run({ name: "slow", cmd: ["slow"], deps: { bun, db }, cacheable: false });
        const after = w.run({ name: "after", cmd: ["after"], deps: { fast, slow } });
        w.saveCache({
          name: "save:bun",
          cache: bun,
          deps: { fast: w.optional(fast), slow: w.optional(slow) },
        });
        w.post({
          name: "down:db",
          main: db,
          cmd: ["db", "stop", db.outputs.pid],
          deps: { after: w.optional(after) },
        });
      },
    });
    const common = {
      workflow: workflow.workflow,
      ...(workflow.summary && { summary: workflow.summary }),
      ports,
      casBaseDir: CAS,
      journalPath: JOURNAL,
    };
    const fastSettled = new Promise<void>((resolve) => {
      const group = ports.ci.group;
      ports.ci.group = (title, lines) => {
        group(title, lines);
        if (title.startsWith("✔\uFE0E fast")) resolve();
      };
    });
    const running = runWorkflow({ ...common, signal: controller.signal });
    await fastSettled;
    controller.abort();
    const run = await running;
    const journal = await readJournal(fs, JOURNAL);
    const post = await runPost(common);
    const again = await runPost(common);
    const status = (rs: { name: string; status: string }[]) =>
      Object.fromEntries(rs.map((r) => [r.name, r.status]));
    const stop = calls.find((c) => c[1] === "stop")!;
    assert.deepEqual(
      {
        run: { cancelled: run.cancelled, failed: run.failed, statuses: status(run.results) },
        journaled: Object.fromEntries(Object.entries(journal).map(([n, e]) => [n, e.status])),
        post: status(post.results),
        again: status(again.results),
        calls: calls.map((c) => c.slice(0, 2)),
        stoppedPid: await fs.readText(stop[2]!),
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
        journaled: {
          "restore:bun": "done",
          "up:db": "done",
          fast: "done",
          slow: "cancelled",
          after: "cancelled",
          "save:bun": "cancelled",
          "down:db": "cancelled",
        },
        post: { "save:bun": "done", "down:db": "done" },
        again: {},
        calls: [["db", "start"], ["fast"], ["slow"], ["db", "stop"]],
        stoppedPid: "7",
        saved: ["bun-old", "bun-new"],
        headersStartsAndRecaps: [
          "7 nodes",
          "▷ restore:bun",
          "▷ up:db",
          "▷ fast",
          "▷ slow",
          "◼\uFE0E cancelled, 4 nodes not run · run · built 3 · cached 0 · failed 0 · skipped 0 · cancelled 4 · wall 11.0s",
          "post · 2 of 2 post steps owed",
          "▷ down:db",
          "▷ save:bun",
          "✔\uFE0E all 2 nodes succeeded · run · post · built 2 · cached 0 · failed 0 · skipped 0 · wall 5.0s",
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
            "save:bun cancelled",
            "down:db cancelled",
            "",
          ].join("\n"),
          ["## run · post", "", "save:bun done", "down:db done", ""].join("\n"),
        ],
        slowLog: ["killed by SIGINT"],
      },
    );
  });
});

describe("runJob", () => {
  test("after a cancel, the same process runs the post steps owed in the run's selection, under its title and summary, and exits 130", async () => {
    const controller = new AbortController();
    const { ports, rec } = createTestPorts();
    const fastSettled = new Promise<void>((resolve) => {
      const group = ports.ci.group;
      ports.ci.group = (title, lines) => {
        group(title, lines);
        if (title.startsWith("✔\uFE0E fast")) resolve();
      };
    });
    ports.sh = {
      run: async (cmd, opts) => {
        if (cmd[0] !== "slow") return { code: 0, stdout: "", stderr: "", output: "", ok: true };
        return new Promise((resolve) =>
          opts!.signal!.addEventListener("abort", () =>
            resolve({ code: -1, stdout: "", stderr: "", output: "", ok: false }),
          ),
        );
      },
    };
    const workflow = defineWorkflow({
      summary: [(r) => r.nodes.map((n) => `${n.name} ${n.status}`)],
      build: (w) => {
        const fast = w.run({ name: "fast", cmd: ["fast"], cacheable: false });
        const slow = w.run({ name: "slow", cmd: ["slow"], cacheable: false });
        w.post({ name: "save", main: fast, cmd: ["save"], deps: { slow: w.optional(slow) } });
        w.post({ name: "notify", main: fast, cmd: ["notify"], deps: {} });
      },
    });
    const job = runJob(
      {
        workflow: workflow.workflow,
        workflowFile: "ci.ts",
        summary: workflow.summary!,
        ports,
        casBaseDir: CAS,
        journalPath: JOURNAL,
        only: ["save"],
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
        log: [
          {
            title: "ci.ts · 3 of 4 nodes (--only save)",
            lines: ["fast", "slow", "save"],
          },
          "▷ fast",
          "▷ slow",
          { title: "✔\uFE0E fast (4.0s)", lines: [] },
          { title: "◼\uFE0E slow (cancelled)", lines: [] },
          "◼\uFE0E save: cancelled",
          "",
          "◼\uFE0E cancelled, 2 nodes not run · ci.ts · built 1 · cached 0 · failed 0 · skipped 0 · cancelled 2 · wall 5.0s",
          "cancelled: slow, save",
          { title: "post · 1 of 1 post steps owed", lines: ["save"] },
          "▷ save",
          { title: "✔\uFE0E save (2.0s)", lines: [] },
          "",
          "✔\uFE0E 1 node succeeded · ci.ts · post · built 1 · cached 0 · failed 0 · skipped 0 · wall 2.0s",
        ],
        summaries: [
          ["## ci.ts", "", "fast done", "slow cancelled", "save cancelled", ""].join("\n"),
          ["## ci.ts · post", "", "save done", ""].join("\n"),
        ],
      },
    );
  });
});

describe("progress", () => {
  test("a node's start line is in the log while it runs: slow cannot finish until fast, which started with it, has settled", async () => {
    const { ports, rec } = createTestPorts();
    const fastSettled = new Promise<void>((resolve) => {
      const group = ports.ci.group;
      ports.ci.group = (title, lines) => {
        group(title, lines);
        if (title.startsWith("✔\uFE0E fast")) resolve();
      };
    });
    ports.sh = {
      run: async (cmd) => {
        if (cmd[0] === "slow") await fastSettled;
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const workflow = defineWorkflow({
      build: (w) => {
        w.run({ name: "slow", cmd: ["slow"], cacheable: false });
        w.run({ name: "fast", cmd: ["fast"], cacheable: false });
      },
    });
    await runWorkflow({
      workflow: workflow.workflow,
      ports,
      casBaseDir: CAS,
      journalPath: JOURNAL,
    });
    assert.deepEqual(
      rec.log.map((e) => (typeof e === "string" ? e : e.title)),
      [
        "2 nodes",
        "▷ slow",
        "▷ fast",
        "✔\uFE0E fast (3.0s)",
        "✔\uFE0E slow (5.0s)",
        "",
        "✔\uFE0E all 2 nodes succeeded · run · built 2 · cached 0 · failed 0 · skipped 0 · wall 5.0s",
      ],
    );
  });
});

describe("cancel during a save", () => {
  test("a save the cancel lands on finishes in the run, and the post pass does not save again", async () => {
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
    const workflow = defineWorkflow({
      build: (w) => {
        const cas = w.restoreCache({ name: "restore:cas", path: [".cas"], key: "cas-1" });
        w.saveCache({ name: "save:cas", cache: cas, deps: {} });
      },
    }).workflow;
    const common = { workflow, ports, casBaseDir: CAS, journalPath: JOURNAL };
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
        post: { "save:cas": "done" },
        saves: 1,
        saved: ["cas-1"],
      },
    );
  });
});

describe("timeoutMinutes", () => {
  test("a step that outlives its timeout fails in the runner's words with a timed_out check, whatever it exits with; it is never cached, and the timeout is not in the key", async () => {
    const { ports, rec } = createTestPorts();
    // `hang` runs until interrupted, then exits 0 with what it printed, as a trapped SIGINT does.
    ports.sh = {
      run: (cmd, opts) =>
        cmd[0] === "hang"
          ? new Promise((resolve) =>
              opts!.signal!.addEventListener("abort", () =>
                resolve({
                  code: 0,
                  stdout: "partial\n",
                  stderr: "",
                  output: "partial\n",
                  ok: true,
                }),
              ),
            )
          : okSh.run(cmd, opts),
    };
    const workflow = (lintMinutes: number) =>
      defineWorkflow({
        build: (w) => {
          const test = w.run({ name: "test", cmd: ["hang"], timeoutMinutes: 0.0005 });
          w.run({ name: "lint", cmd: ["ok"], timeoutMinutes: lintMinutes });
          w.run({ name: "report", cmd: ["ok"], deps: { test: w.optional(test) } });
        },
      }).workflow;
    const common = { ports, casBaseDir: CAS, journalPath: JOURNAL };
    const first = await runWorkflow({ ...common, workflow: workflow(10) });
    const second = await runWorkflow({ ...common, workflow: workflow(20) });
    const status = (rs: { name: string; status: string }[]) =>
      Object.fromEntries(rs.map((r) => [r.name, r.status]));
    const w = createSteps(new Graph(), ports, await ports.ci.context());
    const rejected = [0, -1, Number.NaN, 40_000].filter((timeoutMinutes) => {
      try {
        w.run({ name: `t${timeoutMinutes}`, cmd: ["ok"], timeoutMinutes });
        return false;
      } catch (e) {
        return e instanceof RangeError;
      }
    });
    const message = "The action 'test' has timed out after 30ms.";
    assert.deepEqual(
      {
        first: status(first.results),
        second: status(second.results),
        annotations: rec.annotations,
        checks: rec.checks
          .filter((c) => c.name === "test" && c.status === "completed")
          .map((c) => [c.conclusion, c.summary]),
        log: groupLines(rec.log, `${STATUS_ICON.fail} test`),
        rejected,
      },
      {
        first: { test: "fail", lint: "done", report: "done" },
        second: { test: "fail", lint: "cached", report: "cached" },
        annotations: [
          { level: "error", title: "test", message },
          { level: "error", title: "test", message },
        ],
        checks: [
          ["timed_out", message],
          ["timed_out", message],
        ],
        log: ["partial", "── error ──", message],
        rejected: [0, -1, Number.NaN, 40_000],
      },
    );
  });
});

describe("secrets", () => {
  test("the runner's credentials and the action's inputs reach no command, and nothing a command prints lands in the CAS", async () => {
    const env: Record<string, string> = {
      NPM_TOKEN: "npm-s3cret",
      GITHUB_TOKEN: "ghs-token",
      ACTIONS_RUNTIME_TOKEN: "runtime-token",
      INPUT_WORKFLOW: "scripts/ci.ts",
    };
    const { ports, fs } = createTestPorts({ env });
    const seen: Array<Record<string, string | undefined>> = [];
    ports.sh = {
      run: async (_cmd, opts) => {
        const { DAGACTIONS_OUT: _, ...rest } = opts!.env!;
        seen.push(rest);
        const output = "token npm-s3cret\n";
        return { code: 0, stdout: output, stderr: "", output, ok: true };
      },
    };
    const workflow = defineWorkflow({
      build: (w) => void w.run({ name: "publish", cmd: ["publish"] }),
    }).workflow;
    await runWorkflow({ workflow, ports, casBaseDir: CAS, journalPath: JOURNAL });
    assert.deepEqual(
      {
        seen,
        inCas: [...fs.files]
          .filter(([path, data]) => path.startsWith(`${CAS}/`) && String(data).includes("s3cret"))
          .map(([path]) => path),
      },
      {
        seen: [
          Object.fromEntries(
            [
              "GITHUB_TOKEN",
              "ACTIONS_RUNTIME_TOKEN",
              "ACTIONS_RUNTIME_URL",
              "ACTIONS_CACHE_URL",
              "ACTIONS_RESULTS_URL",
              "INPUT_WORKFLOW",
            ].map((k) => [k, undefined]),
          ),
        ],
        inCas: [],
      },
    );
  });
});
