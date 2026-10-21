import { Graph, type MemoryDagFs } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import { STATUS_ICON } from "./config.ts";
import { readRunHistory } from "./history.ts";
import type { Ports, Sh } from "./ports.ts";
import { createMemoryActionsCache } from "./ports/actions-cache.ts";
import { createMemoryLockfile, createTestPorts, okSh, type RecordedCi } from "./ports/memory.ts";
import { runJob, runPost, runWorkflow } from "./runner.ts";
import { renderStatus, renderTimeline } from "./summary.ts";
import { createSteps, defineWorkflow } from "./workflow.ts";

const CAS = "/cas";

/** The lines of the first logged group whose title starts with `title`. */
const groupLines = (log: RecordedCi["log"], title: string) =>
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

type RunOptions = Parameters<Sh["run"]>[1];
const envOf = (opts: RunOptions) => {
  const env = opts?.env;
  assert.ok(env, "env for the command");
  return env;
};
const outDirOf = (opts: RunOptions) => {
  const out = envOf(opts)["DAGACTIONS_OUT"];
  assert.ok(out, "DAGACTIONS_OUT");
  return out;
};
const signalOf = (opts: RunOptions) => {
  const signal = opts?.signal;
  assert.ok(signal, "signal for the command");
  return signal;
};

describe("cancel, then post", () => {
  test("a cancelled run records what settled in its history; the post pass saves the cache and stops the service from that history, under the workflow's summary; a second pass finds nothing", async () => {
    const controller = new AbortController();
    const calls: string[][] = [];
    const service = createMemoryActionsCache(["bun-old"]);
    const { ports, fs, rec } = createTestPorts({ actionsCache: service });
    // `db start` writes the pid it is asked for; `slow` runs until the cancel interrupts it.
    const sh: Sh = {
      run: async (cmd, opts) => {
        calls.push(cmd);
        if (cmd[0] === "db" && cmd[1] === "start") await fs.writeText(`${outDirOf(opts)}/pid`, "7");
        if (cmd[0] !== "slow") return { code: 0, stdout: "", stderr: "", output: "", ok: true };
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
          deps: { fast: w.settled(fast), slow: w.settled(slow) },
        });
        w.post({
          name: "down:db",
          main: db,
          cmd: ["db", "stop", db.outputs.pid],
          deps: { after: w.settled(after) },
        });
      },
    });
    const common = {
      workflow: workflow.workflow,
      ...(workflow.summary && { summary: workflow.summary }),
      ports,
      casBaseDir: CAS,
      historyDir: HISTORY_DIR,
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
    const recorded = (await histories(fs)).map((j) =>
      Object.fromEntries(Object.entries(j.nodes).map(([n, e]) => [n, e.status])),
    );
    const post = await runPost(common);
    const again = await runPost(common);
    const status = (rs: { name: string; status: string }[]) =>
      Object.fromEntries(rs.map((r) => [r.name, r.status]));
    const stopPidFile = calls.find((c) => c[1] === "stop")?.[2];
    assert.ok(stopPidFile, "stop command");
    assert.deepEqual(
      {
        run: { cancelled: run.cancelled, failed: run.failed, statuses: status(run.results) },
        recorded,
        post: status(post.results),
        again: status(again.results),
        calls: calls.map((c) => c.slice(0, 2)),
        stoppedPid: await fs.readText(stopPidFile),
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
        recorded: [
          {
            "restore:bun": "done",
            "up:db": "done",
            fast: "done",
            slow: "cancelled",
            after: "cancelled",
            "save:bun": "cancelled",
            "down:db": "cancelled",
          },
        ],
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
          "◼\uFE0E cancelled, 4 nodes not run · run · built 3 · cached 0 · failed 0 · skipped 0 · cancelled 4 · wall 9.0s",
          "post · 2 of 2 post steps owed",
          "▷ down:db",
          "▷ save:bun",
          "✔\uFE0E all 2 nodes succeeded · run · post · built 2 · cached 0 · failed 0 · skipped 0 · wall 3.0s",
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
  test("after a cancel, the same process runs the post steps owed in the run's selection, the selected nodes' other posts included, under its title and summary, and exits 130", async () => {
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
          signalOf(opts).addEventListener("abort", () =>
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
        w.post({ name: "save", main: fast, cmd: ["save"], deps: { slow: w.settled(slow) } });
        w.post({ name: "notify", main: fast, cmd: ["notify"], deps: {} });
      },
    });
    assert.ok(workflow.summary, "summary");
    const job = runJob(
      {
        workflow: workflow.workflow,
        workflowFile: "ci.ts",
        summary: workflow.summary,
        ports,
        casBaseDir: CAS,
        historyDir: HISTORY_DIR,
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
            title: "ci.ts · 4 of 4 nodes (--only save)",
            lines: ["fast", "slow", "save", "notify"],
          },
          "▷ fast",
          "▷ slow",
          { title: "✔\uFE0E fast (2.0s)", lines: [] },
          "▷ notify",
          { title: "◼\uFE0E notify (cancelled)", lines: [] },
          { title: "◼\uFE0E slow (cancelled)", lines: [] },
          "◼\uFE0E save: cancelled",
          "",
          "◼\uFE0E cancelled, 3 nodes not run · ci.ts · built 1 · cached 0 · failed 0 · skipped 0 · cancelled 3 · wall 6.0s",
          "cancelled: slow, save, notify",
          { title: "post · 2 of 2 post steps owed", lines: ["save", "notify"] },
          "▷ save",
          "▷ notify",
          { title: "✔\uFE0E save (2.0s)", lines: [] },
          { title: "✔\uFE0E notify (2.0s)", lines: [] },
          "",
          "✔\uFE0E all 2 nodes succeeded · ci.ts · post · built 2 · cached 0 · failed 0 · skipped 0 · wall 3.0s",
        ],
        summaries: [
          [
            "## ci.ts",
            "",
            "fast done",
            "slow cancelled",
            "save cancelled",
            "notify cancelled",
            "",
          ].join("\n"),
          ["## ci.ts · post", "", "save done", "notify done", ""].join("\n"),
        ],
      },
    );
  });
});

describe("a run killed before its post pass", () => {
  test("owes its posts, a post of an owed post too, to the next run, which finishes them from the old history before it begins, reports their failures and does not count them", async () => {
    const { ports, fs, rec } = createTestPorts();
    const stopped: string[] = [];
    let pid = 0;
    let reports = 0;
    let killed = true;
    const controller = new AbortController();
    ports.sh = {
      run: async (cmd, opts) => {
        if (cmd[1] === "start") await fs.writeText(`${outDirOf(opts)}/pid`, String(++pid));
        if (cmd[1] === "stop") {
          const [, , pidFile] = cmd;
          assert.ok(pidFile, "pid file");
          stopped.push(await fs.readText(pidFile));
        }
        if (cmd[0] === "slow" && killed) controller.abort();
        // The report fails the first time it runs, in the post steps owed.
        const ok = cmd[0] !== "report" || reports++ > 0;
        return { code: ok ? 0 : 1, stdout: "", stderr: "", output: "", ok };
      },
    };
    const workflow = defineWorkflow({
      build: (w) => {
        const db = w.run({
          name: "up:db",
          cmd: ["db", "start"],
          outputs: { pid: "pid" },
          cacheable: false,
        });
        const slow = w.run({ name: "slow", cmd: ["slow"], deps: { db }, cacheable: false });
        const down = w.post({
          name: "down:db",
          main: db,
          cmd: ["db", "stop", db.outputs.pid],
          deps: { slow: w.settled(slow) },
        });
        w.post({ name: "report:db", main: down, cmd: ["report"], deps: {} });
        w.run({ name: "lint", cmd: ["lint"], cacheable: false });
        w.post({ name: "down:lint", main: slow, cmd: ["never"], deps: {} });
      },
    }).workflow;
    const common = { workflow, ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
    // Cancelled, then killed before its post pass, by a second Ctrl-C or a closed terminal.
    await runWorkflow({ ...common, signal: controller.signal });
    killed = false;
    rec.log.length = 0;
    const next = await runWorkflow(common);
    assert.deepEqual(
      {
        stopped,
        headers: rec.log
          .map((e) => (typeof e === "string" ? e : e.title))
          .filter((t) => t.startsWith("post ·") || t.startsWith("▷")),
        failed: next.failed,
        annotations: rec.annotations.map(({ level, title }) => ({ level, title })),
      },
      {
        stopped: ["1", "2"],
        headers: [
          "post · 2 of 3 post steps owed",
          "▷ down:db",
          "▷ report:db",
          "▷ up:db (last run 3.0s)",
          "▷ lint (last run 1.0s)",
          "▷ slow",
          "▷ down:db",
          "▷ down:lint",
          "▷ report:db",
        ],
        failed: 0,
        annotations: [{ level: "error", title: "report:db" }],
      },
    );
  });
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
    const workflow = defineWorkflow({
      build: (w) => void w.run({ name: "lint", cmd: ["lint"], cacheable: false }),
    }).workflow;
    const common = { workflow, ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
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
        midWrite: [{ workflow: "", nodes: {} }],
        after: [["lint", "done"]],
        annotations: [
          {
            level: "warning",
            title: "dagactions",
            message: `ignoring the run's history ${HISTORY_DIR}/damaged.json`,
          },
        ],
        left: [],
      },
    );
  });
});

describe("--only", () => {
  test("a post ordered after the selection through a node left out, such as a gate, waits for what runs and runs whether it fails", async () => {
    const { ports } = createTestPorts();
    const events: string[] = [];
    ports.sh = {
      run: async (cmd) => {
        events.push(`start ${cmd.join(" ")}`);
        if (cmd[0] === "e2e") await new Promise((r) => setTimeout(r, 50));
        events.push(`end ${cmd.join(" ")}`);
        const ok = cmd[0] !== "e2e";
        return { code: ok ? 0 : 1, stdout: "", stderr: "", output: "", ok };
      },
    };
    const workflow = defineWorkflow({
      build: (w) => {
        const db = w.run({ name: "up:db", cmd: ["db", "start"], cacheable: false });
        const e2e = w.run({ name: "e2e", cmd: ["e2e"], deps: { db }, cacheable: false });
        const lint = w.run({ name: "lint", cmd: ["lint"], cacheable: false });
        const gate = w.gate({ deps: { e2e, lint } });
        w.post({
          name: "down:db",
          main: db,
          cmd: ["db", "stop"],
          deps: { gate: w.settled(gate) },
        });
      },
    }).workflow;
    const run = await runWorkflow({
      workflow,
      ports,
      casBaseDir: CAS,
      historyDir: HISTORY_DIR,
      only: ["e2e"],
    });
    assert.deepEqual(
      { events, statuses: Object.fromEntries(run.results.map((r) => [r.name, r.status])) },
      {
        events: [
          "start db start",
          "end db start",
          "start e2e",
          "end e2e",
          "start db stop",
          "end db stop",
        ],
        statuses: { "up:db": "done", e2e: "failed", "down:db": "done" },
      },
    );
  });

  test("runs the posts of every node in its closure, each after only its deps that run, and finishes them after a cancel", async () => {
    const { ports } = createTestPorts();
    const calls: string[] = [];
    const controller = new AbortController();
    let cancelAtE2e = false;
    ports.sh = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        if (cmd[0] === "e2e" && cancelAtE2e) controller.abort();
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const workflow = defineWorkflow({
      build: (w) => {
        const db = w.run({ name: "up:db", cmd: ["db", "start"], cacheable: false });
        const e2e = w.run({ name: "e2e", cmd: ["e2e"], deps: { db }, cacheable: false });
        const lint = w.run({ name: "lint", cmd: ["lint"], cacheable: false });
        w.post({
          name: "down:db",
          main: db,
          cmd: ["db", "stop"],
          deps: { e2e: w.settled(e2e), lint: w.settled(lint) },
        });
        w.post({ name: "down:lint", main: lint, cmd: ["lint", "clean"], deps: {} });
      },
    }).workflow;
    const common = { workflow, ports, casBaseDir: CAS, historyDir: HISTORY_DIR, only: ["e2e"] };
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
    ports.sh = {
      run: async (cmd, opts) => {
        events.push(cmd.join(" "));
        if (cmd[0] === "e2e") {
          e2eRunning.resolve();
          await new Promise((r) => signalOf(opts).addEventListener("abort", r));
        }
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const workflow = defineWorkflow({
      build: (w) => {
        const db = w.run({ name: "up:db", cmd: ["db", "start"], cacheable: false });
        const e2e = w.run({ name: "e2e", cmd: ["e2e"], deps: { db }, cacheable: false });
        w.run({ name: "lint", cmd: ["lint"], cacheable: false });
        w.post({ name: "down:db", main: db, cmd: ["db", "stop"], deps: { e2e: w.settled(e2e) } });
      },
    }).workflow;
    const common = { workflow, ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
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
    ports.sh = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        if (cmd[0] === "e2e") controller.abort();
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const workflow = defineWorkflow({
      build: (w) => {
        const db = w.run({ name: "up:db", cmd: ["db", "start"], cacheable: false });
        const e2e = w.run({ name: "e2e", cmd: ["e2e"], deps: { db }, cacheable: false });
        w.post({ name: "down:db", main: db, cmd: ["db", "stop"], deps: { e2e: w.settled(e2e) } });
      },
    }).workflow;
    const common = { workflow, ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
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
    ports.sh = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        if (cmd[0] === "check" && killed) controller.abort();
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const a = defineWorkflow({
      build: (w) => {
        const cas = w.run({ name: "restore:cas", cmd: ["restore"], cacheable: false });
        const check = w.run({ name: "check", cmd: ["check"], deps: { cas }, cacheable: false });
        w.post({
          name: "down:a",
          main: cas,
          cmd: ["a", "cleanup"],
          deps: { check: w.settled(check) },
        });
      },
    }).workflow;
    const b = defineWorkflow({
      build: (w) => {
        const cas = w.run({ name: "restore:cas", cmd: ["restore"], cacheable: false });
        w.post({ name: "save:cas", main: cas, cmd: ["b", "save"], deps: {} });
      },
    }).workflow;
    const common = { ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
    await runWorkflow({ ...common, workflow: a, workflowFile: "a.ts", signal: controller.signal });
    killed = false;
    const ranA = calls.splice(0);
    await runWorkflow({ ...common, workflow: b, workflowFile: "b.ts" });
    const ranB = calls.splice(0);
    await runWorkflow({ ...common, workflow: a, workflowFile: "a.ts" });
    assert.deepEqual(
      { ranA, ranB, ranAgain: calls },
      {
        ranA: ["restore", "check"],
        ranB: ["restore", "b save"],
        ranAgain: ["a cleanup", "restore", "check", "a cleanup"],
      },
    );
  });

  test("leaves out a post whose command refers to a step it leaves out, and that post's own posts, with a notice", async () => {
    const { ports, rec } = createTestPorts();
    const calls: string[] = [];
    ports.sh = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const workflow = defineWorkflow({
      build: (w) => {
        const db = w.run({ name: "up:db", cmd: ["db", "start"], cacheable: false });
        w.run({ name: "e2e", cmd: ["e2e"], deps: { db }, cacheable: false });
        const dump = w.run({ name: "dump", cmd: ["dump"], cacheable: false });
        const down = w.post({
          name: "down:db",
          main: db,
          cmd: ["rm", "-rf", `${dump.outputs.result}/tmp`],
          deps: { dump: w.settled(dump) },
        });
        w.post({ name: "report", main: down, cmd: ["report"], deps: {} });
      },
    }).workflow;
    const run = await runWorkflow({
      workflow,
      ports,
      casBaseDir: CAS,
      historyDir: HISTORY_DIR,
      only: ["e2e"],
    });
    assert.deepEqual(
      {
        calls,
        statuses: Object.fromEntries(run.results.map((r) => [r.name, r.status])),
        annotations: rec.annotations,
      },
      {
        calls: ["db start", "e2e"],
        statuses: { "up:db": "done", e2e: "done" },
        annotations: [
          {
            level: "notice",
            title: "down:db",
            message: "not run: its command refers to an output of a step --only leaves out",
          },
        ],
      },
    );
  });
});

describe("a killed --only run", () => {
  test("owes the posts of its own selection, whose required deps outside it never ran", async () => {
    const { ports, fs } = createTestPorts();
    const stopped: string[] = [];
    let pid = 0;
    let killed = true;
    const controller = new AbortController();
    ports.sh = {
      run: async (cmd, opts) => {
        if (cmd[1] === "start") await fs.writeText(`${outDirOf(opts)}/pid`, String(++pid));
        if (cmd[1] === "stop") {
          const [, , pidFile] = cmd;
          assert.ok(pidFile, "pid file");
          stopped.push(await fs.readText(pidFile));
        }
        if (cmd[0] === "e2e" && killed) controller.abort();
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const workflow = defineWorkflow({
      build: (w) => {
        const db = w.run({
          name: "up:db",
          cmd: ["db", "start"],
          outputs: { pid: "pid" },
          cacheable: false,
        });
        const seed = w.run({ name: "seed", cmd: ["seed"], cacheable: false });
        w.run({ name: "e2e", cmd: ["e2e"], deps: { db }, cacheable: false });
        w.post({ name: "down:db", main: db, cmd: ["db", "stop", db.outputs.pid], deps: { seed } });
      },
    }).workflow;
    const common = { workflow, ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
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
    const outs: string[] = [];
    // Run A writes its log first; then B's log write stops halfway while A's reporter reads.
    ports.sh = {
      run: async (_cmd, opts) => {
        const run = outs.push(outDirOf(opts)) === 1 ? "A" : "B";
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
        } else if (path === `${outs[0]}/result.json`) {
          aWrote.resolve();
          await bHalf.promise;
        }
        return fs.writeText(path, content);
      },
    };
    const workflow = defineWorkflow({
      build: (w) => void w.run({ name: "x", cmd: ["x"], cacheable: false }),
    }).workflow;
    const common = { workflow, ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
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
    const { ports, fs, rec } = createTestPorts({ clock: { now: () => now } });
    // Each command takes a second.
    ports.sh = {
      run: async () => {
        now += 1000;
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    const def = defineWorkflow({
      limits: { concurrencyLimits: { one: 1 } },
      summary: [renderStatus, renderTimeline],
      build: (w) => {
        for (const name of ["a", "b", "c"]) w.run({ name, cmd: [name], group: "one" });
      },
    });
    assert.ok(def.limits && def.summary, "limits and summary");
    await runWorkflow({
      workflow: def.workflow,
      limits: def.limits,
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
    const common = { workflow, ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
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
          : okSh.run(cmd, opts),
    };
    const workflow = (lintMinutes: number) =>
      defineWorkflow({
        build: (w) => {
          const test = w.run({ name: "test", cmd: ["hang"], timeoutMinutes: 0.0005 });
          w.run({ name: "lint", cmd: ["ok"], timeoutMinutes: lintMinutes });
          w.run({ name: "report", cmd: ["ok"], deps: { test: w.settled(test) } });
        },
      }).workflow;
    const common = { ports, casBaseDir: CAS, historyDir: HISTORY_DIR };
    const first = await runWorkflow({ ...common, workflow: workflow(10) });
    const second = await runWorkflow({ ...common, workflow: workflow(20) });
    const status = (rs: { name: string; status: string }[]) =>
      Object.fromEntries(rs.map((r) => [r.name, r.status]));
    const w = createSteps(new Graph<Ports>(), ports, await ports.ci.context());
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
        log: groupLines(rec.log, `${STATUS_ICON.failed} test`),
        rejected,
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
        rejected: [0, -1, Number.NaN, 40_000],
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
    const seen: Array<Record<string, string | undefined>> = [];
    ports.sh = {
      run: async (_cmd, opts) => {
        const { DAGACTIONS_OUT: _, ...rest } = envOf(opts);
        seen.push(rest);
        const output = "token npm-s3cret\n";
        return { code: 0, stdout: output, stderr: "", output, ok: true };
      },
    };
    const workflow = defineWorkflow({
      build: (w) => void w.run({ name: "publish", cmd: ["publish"] }),
    }).workflow;
    await runWorkflow({ workflow, ports, casBaseDir: CAS, historyDir: HISTORY_DIR });
    const inCas = [...fs.files]
      .filter(([path, data]) => path.startsWith(`${CAS}/`) && String(data).includes("s3cret"))
      .map(([path]) => path);
    // createSh merges what the step sets over process.env, so nothing set here is inherited.
    assert.deepEqual({ seen, inCas }, { seen: [{}], inCas: [] });
  });
});
