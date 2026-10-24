import { settled, type ExecEvent, type JsonValue, type Node, type Result } from "@mrmeku/dagraph";
import xterm from "@xterm/headless";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, mock, test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { styleText } from "node:util";
import { addCommand } from "../commands.ts";
import { LIVE_FRAME_MS, type OutputStyle } from "../config.ts";
import { defineStep } from "../define-step.ts";
import { errorMessage } from "../kernel/format.ts";
import type { Exec, ExecResult, Ports } from "../ports.ts";
import { clockAt, createMemorySyncFs, createTestPorts } from "../ports/memory.ts";
import { runJob, type RunOptions } from "../runner.ts";
import { defineWorkflow } from "../workflow.ts";
import { createLocalSession } from "./session.ts";
import type { WriteStreams } from "./terminal/frame.ts";

const signalOf = (opts: Parameters<Exec["run"]>[1]) => {
  const signal = opts?.signal;
  assert.ok(signal, "signal for the command");
  return signal;
};

/** A line of the terminal's buffer, as text. */
const lineText = (buffer: xterm.IBuffer, i: number) => {
  const line = buffer.getLine(i);
  assert.ok(line, `line ${i}`);
  return line.translateToString(true);
};

/**
 * A local run as the CLI wires it, on memory files and a 40×12 terminal recording its writes;
 * `terminal` changes what the terminal says of itself. `job` runs it as `dag run` does,
 * in `processEvents`, which then exits: it resolves to the exit code, or rejects with what the run threw.
 */
function localRun(
  outputStyle: OutputStyle,
  ports: Ports,
  run: Partial<RunOptions> = {},
  terminal: Partial<WriteStreams["stdout"]> = {},
) {
  const writes: string[] = [];
  const write = (chunk: string | Uint8Array) => writes.push(String(chunk)) > 0;
  const streams: WriteStreams = {
    stdout: { write, columns: 40, rows: 12, ...terminal },
    stderr: { write },
  };
  const files = createMemorySyncFs();
  const session = createLocalSession(
    {
      implementation: async () => {},
      workflowFile: "ci.ts",
      ports,
      casBaseDir: "/cas",
      historyDir: "/history",
      ...run,
    },
    {
      outputStyle,
      syncFs: files,
      streams,
    },
  );
  const processEvents = new EventEmitter();
  return {
    runOptions: session,
    processEvents,
    job: (signal?: AbortSignal) =>
      runJob({ ...session, ...(signal && { signal }) }, processEvents).finally(() =>
        processEvents.emit("exit"),
      ),
    files,
    streams,
    writes,
    report: () => {
      const report = files.files.get(".dag/failures.md");
      assert.ok(typeof report === "string", "failures report");
      return report.split("\n");
    },
    logs: () => Object.fromEntries([...files.files].filter(([path]) => path.endsWith(".log"))),
    stdout: () => writes.join("").split("\n"),
    screen: () => screen(writes),
    /** The rows the last frame drew under the scrollback, escapes and all. */
    footer: () => /\x1b\[\?7l([^]*)\r\x1b\[\?7h/.exec(writes.at(-1) ?? "")?.[1]?.split("\n") ?? [],
    tick: () => mock.timers.tick(LIVE_FRAME_MS),
  };
}

/** What a 40×12 terminal shows after `writes`, scrollback first, trailing blank rows dropped. */
async function screen(writes: string[]): Promise<string[]> {
  const term = new xterm.Terminal({
    cols: 40,
    rows: 12,
    scrollback: 1000,
    convertEol: true,
    allowProposedApi: true,
  });
  await new Promise<void>((written) => term.write(writes.join(""), written));
  const buffer = term.buffer.active;
  const out = Array.from({ length: buffer.length }, (_, i) => lineText(buffer, i));
  while (out.at(-1) === "") out.pop();
  return out;
}

/**
 * An Exec whose commands print their chunks and exit as `output` says, by the command's name;
 * any other, such as the local host's git, prints nothing and succeeds.
 */
const scriptedExec = (output: Record<string, { chunks: string[]; code: number }>): Exec => ({
  run: async (cmd, opts) => {
    const { chunks, code } = output[cmd[0] ?? ""] ?? { chunks: [], code: 0 };
    for (const chunk of chunks) opts?.onOutput?.(chunk);
    const all = chunks.join("");
    return { code, stdout: all, stderr: "", output: all, ok: code === 0 };
  },
});

// A test that waits on the run fails when the run never gets there, instead of hanging the suite.
const RUN_TIMEOUT = { timeout: 10_000 };

/** The engine's events for `node`, as a store hears them from a run. */
const dispatchOf = (node: Node): ExecEvent => ({ type: "dispatch", node: node.name });
const startOf = (node: Node): ExecEvent => ({ type: "start", node: node.name });
const outputOf = (node: Node, chunk: string): ExecEvent => ({
  type: "output",
  node: node.name,
  chunk,
});
type Settled<R = Result> = R extends unknown ? Omit<R, "name"> : never;
const resultOf = (node: Node, result: Settled): ExecEvent => ({
  type: "result",
  node: node.name,
  result: { name: node.name, ...result },
});
const failureOf = (node: Node, actionKey: string, message: string, cause?: JsonValue) =>
  resultOf(node, {
    actionKey,
    status: "failed",
    error: { name: "Error", message, ...(cause !== undefined && { cause }) },
    elapsed: 1,
  });

/** Lets the run go on a turn at a time until `done`, or until the test has timed out. */
async function waitUntil(t: TestContext, done: () => boolean | Promise<boolean>, turn = () => {}) {
  while (!(await done())) {
    t.signal.throwIfAborted();
    await new Promise(setImmediate);
    turn();
  }
}

const testLine = (i: number, j: number) =>
  `pkg${i} test line ${j} with some typical output text here`;

const LINT_CHUNKS = [
  "lin",
  "ting\r\n",
  ...Array.from({ length: 70 }, (_, i) => `src/a${i + 1}.ts:1:1\terror\n`),
  "\x1b[1m70 problems\x1b[22m",
];

describe("local session, grouped style", () => {
  test("GitHub's groups on the local adapter, the log files and failures.md beside them", async () => {
    const { ports } = createTestPorts({
      exec: scriptedExec({
        lint: { chunks: ["checking\n", "\x1b[31merror\x1b[0m"], code: 1 },
        up: { chunks: ["up\n\n"], code: 0 },
      }),
      files: { "/cas/last-run.json": JSON.stringify({ durations: { lint: 2000 } }) },
      clock: clockAt(),
    });
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        workflow.cache({ path: [".dag/cas"], key: "k" });
        const lint = workflow.task({ name: "lint", cmd: ["lint"], cacheable: false });
        const up = workflow.task({ name: "../up", cmd: ["up"], cacheable: false });
        const abs = workflow.task({ name: "/abs", cmd: ["up"], cacheable: false });
        const colon = workflow.task({ name: ":", cmd: ["up"], cacheable: false });
        // After every other step, so its start line follows their groups.
        workflow.requireAll({ deps: { lint, up, abs, colon } });
      },
    });
    const session = localRun("grouped", ports, { implementation, workflowFile: "ci flows.ts" });
    session.files.files.set(".dag/logs/old.log", "a node outside this run\n");
    session.files.files.set(".dag/logs/lint.log", "lint's last run\n");
    const { writeFileSync } = session.files;
    session.files.writeFileSync = (path, data) => {
      if (String(path).endsWith("failures.md")) throw new Error("EACCES: permission denied");
      writeFileSync(path, data);
    };
    const code = await session.job();
    assert.deepEqual(
      { code, stdout: session.stdout(), logs: session.logs() },
      {
        code: 1,
        stdout: [
          "▶ ci flows.ts · 6 nodes",
          ...["restore:cache", "lint", "../up", "/abs", ":", "require-all"].map(
            (node) => `    ${node}`,
          ),
          "[warning] dag: failures report off: EACCES: permission denied",
          "▷ restore:cache",
          "▷ lint (last run 2.0s)",
          "▷ ../up",
          "▷ /abs",
          "▷ :",
          "▶ ✔︎ restore:cache (1ms)",
          "    Cache not found for input keys: k",
          "▶ ✖︎ lint (1ms)",
          "    checking",
          "    \x1b[31merror\x1b[0m",
          "    ── error ──",
          "    lint exited 1",
          "[error] lint: lint exited 1",
          "▶ ✔︎ ../up (1ms)",
          "    up",
          "▶ ✔︎ /abs (1ms)",
          "    up",
          "▶ ✔︎ : (1ms)",
          "    up",
          "▷ require-all",
          "▶ ✖︎ require-all (1ms)",
          "    ── error ──",
          "    failed: lint",
          "[error] require-all: failed: lint",
          "summary: .dag/summary.md",
          "",
          "✖︎ lint failed · ci flows.ts · built 4 · cached 0 · failed 2 · skipped 0 · wall 1ms",
          "failed: lint, require-all",
          "reproduce: npx --no dag run 'ci flows.ts' --only lint",
          "",
        ],
        logs: {
          ".dag/logs/old.log": "a node outside this run\n",
          ".dag/logs/restore/cache.log": "Cache not found for input keys: k\n",
          ".dag/logs/lint.log": "checking\nerror\n",
          ".dag/logs/%2E%2E/up.log": "up\n\n",
          ".dag/logs/abs.log": "up\n\n",
          ".dag/logs/%3A.log": "up\n\n",
          ".dag/logs/require-all.log": "",
        },
      },
    );
  });
});

describe("local session, failures style", () => {
  test("own failures as blocks, what they brought down in the recap, the logs and the report", async () => {
    const { ports } = createTestPorts({
      exec: scriptedExec({
        install: { chunks: ["installed\n"], code: 0 },
        lint: { chunks: LINT_CHUNKS, code: 1 },
        build: { chunks: [], code: 0 },
        upload: { chunks: ["ECONNREFUSED 127.0.0.1:9000\n"], code: 3 },
        pack: { chunks: ["packed\n", `${"=".repeat(600)}\n`], code: 0 },
      }),
      clock: clockAt(),
    });
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const install = workflow.task({ name: "install", cmd: ["install"], cacheable: false });
        const lint = workflow.task({
          name: "lint",
          cmd: ["lint"],
          deps: { install },
          cacheable: false,
        });
        const build = workflow.task({ name: "build", cmd: ["build", "--prod"], deps: { install } });
        const requireAll = workflow.requireAll({ deps: { lint, build } });
        workflow.task({ name: "deploy:site", cmd: ["deploy"], deps: { requireAll } });
        workflow.task({
          name: "upload",
          cmd: ["upload"],
          deps: { lint: settled(lint) },
          cacheable: false,
        });
        workflow.task({
          name: "pack",
          cmd: ["pack"],
          outputs: { tarball: "pkg.tgz" },
          cacheable: false,
        });
      },
    });
    const session = localRun("failures", ports, { implementation });
    const code = await session.job();
    const errors = (first: number, last: number) =>
      Array.from({ length: last - first + 1 }, (_, i) => `src/a${first + i}.ts:1:1\terror`);
    assert.deepEqual(
      {
        code,
        terminal: session.stdout(),
        report: session.report(),
        logs: session.logs(),
      },
      {
        code: 1,
        terminal: [
          "ci.ts · 7 nodes · report .dag/failures.md",
          "✖︎ pack  0.0s · 2 lines",
          "│ packed",
          `│ ${"=".repeat(500)}…`,
          '│ output "tarball" (pkg.tgz) was not written. Write it at out.tarball before the action returns.',
          "├ log    .dag/logs/pack.log",
          "├ cmd    pack   (cwd .)",
          "└ rerun  npx --no dag run ci.ts --only pack",
          "✖︎ lint  exit 1 · 0.0s · 72 lines",
          "│ … 52 earlier lines",
          ...errors(52, 70).map((line) => `│ ${line}`),
          "│ 70 problems",
          "├ log    .dag/logs/lint.log",
          "├ cmd    lint   (cwd .)",
          "└ rerun  npx --no dag run ci.ts --only lint",
          "✖︎ upload  exit 3 · 0.0s · 1 line",
          "│ ECONNREFUSED 127.0.0.1:9000",
          "├ log    .dag/logs/upload.log",
          "├ cmd    upload   (cwd .)",
          "├ deps   lint also failed",
          "└ rerun  npx --no dag run ci.ts --only upload",
          "summary: .dag/summary.md",
          "",
          "✖︎ lint, upload, pack failed · ci.ts · wall 0.0s",
          "built 2 · cached 0 · failed 4 · skipped 1",
          "",
          "✖︎ lint     exit 1 · 0.0s · 72 lines   .dag/logs/lint.log",
          "  ✖︎ require-all failed because of it",
          "  ⏭︎ deploy:site skipped because of it",
          "✖︎ upload   exit 3 · 0.0s · 1 line   .dag/logs/upload.log",
          "✖︎ pack     0.0s · 2 lines   .dag/logs/pack.log",
          "",
          "rerun    npx --no dag run ci.ts --only lint,upload,pack",
          "report   .dag/failures.md",
          "logs     .dag/logs/",
          "style: failures · every node's log inline: --output-style=grouped",
          "",
        ],
        report: [
          "# Failures · ci.ts",
          "",
          "status: finished · started 1970-01-01T00:00:00.000Z · wall 0.0s",
          "✖︎ lint, upload, pack failed · built 2 · cached 0 · failed 4 · skipped 1",
          "",
          "## ✖︎ lint · exit 1 · 0.0s · 72 lines",
          "",
          "- command: `lint` (cwd `.`)",
          "- log: `.dag/logs/lint.log` (72 lines)",
          "- failed because of it: `require-all` (failed: lint)",
          "- skipped because of it: `deploy:site`",
          "- rerun: `npx --no dag run ci.ts --only lint`",
          "",
          "```text",
          ...errors(12, 70),
          "70 problems",
          "```",
          "",
          "## ✖︎ upload · exit 3 · 0.0s · 1 line",
          "",
          "- command: `upload` (cwd `.`)",
          "- log: `.dag/logs/upload.log` (1 line)",
          "- dependencies that also failed: `lint`",
          "- rerun: `npx --no dag run ci.ts --only upload`",
          "",
          "```text",
          "ECONNREFUSED 127.0.0.1:9000",
          "```",
          "",
          "## ✖︎ pack · 0.0s · 2 lines",
          "",
          "- command: `pack` (cwd `.`)",
          '- error: output "tarball" (pkg.tgz) was not written. Write it at out.tarball before the action returns.',
          "- log: `.dag/logs/pack.log` (2 lines)",
          "- rerun: `npx --no dag run ci.ts --only pack`",
          "",
          "```text",
          "packed",
          "=".repeat(600),
          "```",
          "",
          "Logs: .dag/logs/ · summary: .dag/summary.md",
          "",
        ],
        logs: {
          ".dag/logs/install.log": "installed\n",
          ".dag/logs/pack.log": `packed\n${"=".repeat(600)}\n`,
          ".dag/logs/lint.log": ["linting", ...errors(1, 70), "70 problems", ""].join("\n"),
          ".dag/logs/build.log": "",
          ".dag/logs/upload.log": "ECONNREFUSED 127.0.0.1:9000\n",
          ".dag/logs/require-all.log": "",
        },
      },
    );
  });

  test("thirty failing nodes of sixty, within an agent's budget", async () => {
    const { ports } = createTestPorts({
      exec: {
        run: async (cmd, opts) => {
          const i = Number(cmd[1]);
          const output =
            cmd[0] === "test"
              ? Array.from({ length: 30 }, (_, j) => `${testLine(i, j + 1)}\n`).join("")
              : "";
          opts?.onOutput?.(output);
          const code = cmd[0] === "test" ? 1 : 0;
          return { code, stdout: output, stderr: "", output, ok: code === 0 };
        },
      },
      clock: clockAt(),
    });
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const install = workflow.task({ name: "install", cmd: ["install"], cacheable: false });
        for (let i = 0; i < 30; i++) {
          const test = workflow.task({
            name: `packages/pkg${i}:test`,
            cmd: ["test", String(i)],
            deps: { install },
            cacheable: false,
          });
          workflow.task({ name: `packages/pkg${i}:build`, cmd: ["build"], deps: { test } });
        }
      },
    });
    const session = localRun("failures", ports, { implementation });
    await session.job();
    const name = (i: number) => `packages/pkg${i}:test`;
    const file = (i: number) => `.dag/logs/packages/pkg${i}/test.log`;
    const line = (i: number) => `✖︎ ${name(i)}   exit 1 · 0.0s · 30 lines   ${file(i)}`;
    const block = (i: number, first: number) => [
      `✖︎ ${name(i)}  exit 1 · 0.0s · 30 lines`,
      ...(first > 1 ? [`│ … ${first - 1} earlier lines`] : []),
      ...Array.from({ length: 31 - first }, (_, j) => `│ ${testLine(i, first + j)}`),
      `├ log    ${file(i)}`,
      `├ cmd    test ${i}   (cwd .)`,
      `└ rerun  npx --no dag run ci.ts --only ${name(i)}`,
    ];
    const stdout = session.stdout();
    assert.deepEqual(
      { underTenThousand: stdout.join("\n").length < 10_000, stdout },
      {
        underTenThousand: true,
        stdout: [
          "ci.ts · 61 nodes · report .dag/failures.md",
          ...block(0, 1),
          ...block(1, 1),
          ...block(2, 16),
          ...Array.from({ length: 26 }, (_, i) => line(i + 3)),
          "",
          "✖︎ packages/pkg0:test, packages/pkg1:test, packages/pkg2:test and 27 more failed · ci.ts · wall 0.0s",
          "built 1 · cached 0 · failed 30 · skipped 30",
          "",
          ...[0, 1, 2].flatMap((i) => [
            line(i),
            `  ⏭︎ packages/pkg${i}:build skipped because of it`,
          ]),
          "✖︎ 27 more, in the report",
          "",
          `rerun    npx --no dag run ci.ts --only ${Array.from({ length: 30 }, (_, i) => name(i)).join(",")}`,
          "report   .dag/failures.md",
          "logs     .dag/logs/",
          "2 lines left out · all of it in .dag/failures.md",
          "style: failures · every node's log inline: --output-style=grouped",
          "",
        ],
      },
    );
  });

  test("a forced exit while a node runs", RUN_TIMEOUT, async (t) => {
    const awk = ["awk", "/``/ { print; bad = 1 } END { exit bad }", "docs/a.md"];
    const others = scriptedExec({ awk: { chunks: ["```\nRun ``bun test`` first\n"], code: 1 } });
    let started = () => {};
    const buildStarted = new Promise<void>((resolve) => (started = resolve));
    let exit = (_: ExecResult) => {};
    let publish = () => {};
    const published = new Promise<void>((resolve) => (publish = resolve));
    const { ports } = createTestPorts({
      exec: {
        run: async (cmd, opts) => {
          if (cmd[0] === "pages") await published;
          if (cmd[0] !== "build") return others.run(cmd, opts);
          opts?.onOutput?.("compiling\n\x1b[1m50%\x1b[22m");
          started();
          // It ignores the cancel, as a command that traps SIGINT does.
          return new Promise((resolve) => (exit = resolve));
        },
      },
      clock: clockAt(),
    });
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const lint = workflow.task({ name: "lint docs", cmd: awk, cacheable: false });
        workflow.task({ name: "build", cmd: ["build"], cacheable: false });
        const requireAll = workflow.requireAll({ deps: { lint } });
        const pages = workflow.task({ name: "pages", cmd: ["pages"], cacheable: false });
        // Skipped only once `pages` is done, well after require-all failed.
        workflow.task({ name: "deploy", cmd: ["deploy"], deps: { requireAll, pages } });
      },
    });
    const session = localRun("failures", ports, { implementation });
    const controller = new AbortController();
    const job = session.job(controller.signal);
    await buildStarted;
    await waitUntil(t, () =>
      session.report().includes("- failed because of it: `require-all` (failed: lint)"),
    );
    publish();
    await waitUntil(t, () => session.report().includes("- skipped because of it: `deploy`"));
    const headMidRun = session.report().slice(0, 4);
    // A first Ctrl-C cancels; a second exits the process.
    controller.abort();
    session.processEvents.emit("exit");
    const atExit = { stdout: session.stdout(), report: session.report(), logs: session.logs() };
    exit({ code: 130, stdout: "", stderr: "", output: "", ok: false });
    await job;
    assert.deepEqual(
      { headMidRun, ...atExit },
      {
        headMidRun: [
          "# Failures · ci.ts",
          "",
          "status: running · started 1970-01-01T00:00:00.000Z",
          "",
        ],
        stdout: [
          "ci.ts · 5 nodes · report .dag/failures.md",
          "✖︎ lint docs  exit 1 · 0.0s · 2 lines",
          "│ ```",
          "│ Run ``bun test`` first",
          "├ log    .dag/logs/lint docs.log",
          "├ cmd    awk '/``/ { print; bad = 1 } END { exit bad }' docs/a.md   (cwd .)",
          "└ rerun  npx --no dag run ci.ts --only 'lint docs'",
          "",
          "◼︎ forced exit while build ran · report .dag/failures.md",
          "",
        ],
        report: [
          "# Failures · ci.ts",
          "",
          "status: interrupted · started 1970-01-01T00:00:00.000Z",
          "✖︎ lint docs failed · built 1 · cached 0 · failed 2 · skipped 1",
          "",
          "A forced exit stopped the run while `build` ran.",
          "",
          "## ✖︎ lint docs · exit 1 · 0.0s · 2 lines",
          "",
          "- command: ``` awk '/``/ { print; bad = 1 } END { exit bad }' docs/a.md ``` (cwd `.`)",
          "- log: `.dag/logs/lint docs.log` (2 lines)",
          "- failed because of it: `require-all` (failed: lint)",
          "- skipped because of it: `deploy`",
          "- rerun: `npx --no dag run ci.ts --only 'lint docs'`",
          "",
          "````text",
          "```",
          "Run ``bun test`` first",
          "````",
          "",
          "Logs: .dag/logs/ · summary: .dag/summary.md",
          "",
        ],
        logs: {
          ".dag/logs/lint docs.log": "```\nRun ``bun test`` first\n",
          ".dag/logs/pages.log": "",
          ".dag/logs/build.log": "compiling\n50%\n",
          ".dag/logs/require-all.log": "",
        },
      },
    );
  });

  test("a run that errors before any node runs", async () => {
    const { ports } = createTestPorts();
    const { implementation } = defineWorkflow({
      implementation: () => {
        throw new Error("bad config\n    at ci.ts:3");
      },
    });
    const session = localRun("failures", ports, { implementation });
    const thrown = await session.job().catch(errorMessage);
    assert.deepEqual(
      { thrown, stdout: session.stdout(), report: session.report() },
      {
        thrown: "bad config\n    at ci.ts:3",
        stdout: [
          "",
          "✖︎ errored: bad config · ci.ts",
          "",
          "report   .dag/failures.md",
          "logs     .dag/logs/",
          "style: failures · every node's log inline: --output-style=grouped",
          "",
        ],
        report: [
          "# Failures · ci.ts",
          "",
          "status: errored",
          "✖︎ errored: bad config",
          "",
          "```text",
          "bad config",
          "    at ci.ts:3",
          "```",
          "",
          "Logs: .dag/logs/ · summary: .dag/summary.md",
          "",
        ],
      },
    );
  });
});

describe("local session, failures style, at the edges", () => {
  test("a post step that printed before its cancel, then hit the cache in the post pass, has the cached log", async () => {
    const { ports } = createTestPorts({ files: { "/cas.logs/ks.log": "saved from the cache\n" } });
    const session = localRun("failures", ports);
    const { store } = session.runOptions;
    const save: Node = { name: "save", kind: "save", deps: [] };
    const post = { title: "dag · ci.ts · post", nodes: [save] };
    store.begin({ title: "dag · ci.ts", nodes: [save] });
    store.onEvent(dispatchOf(save));
    store.onEvent(startOf(save));
    store.onEvent(outputOf(save, "saving\n"));
    store.cancel();
    store.onEvent(resultOf(save, { actionKey: "", status: "cancelled" }));
    store.begin(post);
    store.onEvent(dispatchOf(save));
    store.onEvent(
      resultOf(save, { actionKey: "ks", status: "cached", outputs: "", contentHash: "h" }),
    );
    await store.report(post);
    assert.deepEqual(session.logs(), { ".dag/logs/save.log": "saved from the cache\n" });
  });

  test("causes that name no command, two timeouts, log files off, a terminal with colours", async () => {
    const { ports } = createTestPorts({
      exec: {
        run: (cmd, opts) => {
          // `hang` traps the signal its timeout sends and exits 0; `stuck` is killed by it.
          if (cmd[0] !== "hang" && cmd[0] !== "stuck") return scriptedExec({}).run(cmd, opts);
          opts?.onOutput?.("waiting\n");
          const output = "waiting\n";
          const code = cmd[0] === "hang" ? 0 : 130;
          return new Promise((resolve) =>
            signalOf(opts).addEventListener("abort", () =>
              resolve({ code, stdout: output, stderr: "", output, ok: code === 0 }),
            ),
          );
        },
      },
      clock: clockAt(),
    });
    const upload = defineStep({
      kind: "upload",
      inputs: { version: 1 },
      action: async () => {
        // A cause shaped like a command's but for its cwd: no command.
        throw new Error("upload refused", { cause: { argv: ["curl", "-f", "s3://b"], code: 22 } });
      },
    });
    // An agent's terminal may take colours and links; the failures style uses neither.
    process.env.FORCE_HYPERLINK = "1";
    const session = localRun(
      "failures",
      ports,
      {
        implementation: async (graph) => {
          for (const name of ["hang", "stuck"])
            addCommand(graph, { name, cmd: [name], timeoutMs: 6, cacheable: false });
          upload.addNode(graph, {});
        },
      },
      { isTTY: true, hasColors: () => true },
    );
    delete process.env.FORCE_HYPERLINK;
    const { writeFileSync } = session.files;
    session.files.writeFileSync = (path, data) => {
      if (String(path).endsWith(".log")) throw new Error("EACCES: permission denied");
      writeFileSync(path, data);
    };
    await session.job();
    assert.deepEqual(session.stdout(), [
      "ci.ts · 3 nodes · report .dag/failures.md",
      "[warning] dag: log files off: EACCES: permission denied",
      "✖︎ upload  0.0s",
      "│ upload refused",
      "└ rerun  npx --no dag run ci.ts --only upload",
      "✖︎ hang  timed out · 0.0s · 1 line",
      "│ waiting",
      "│ The action 'hang' has timed out after 6ms.",
      "├ cmd    hang   (cwd .)",
      "└ rerun  npx --no dag run ci.ts --only hang",
      "✖︎ stuck  timed out · 0.0s · 1 line",
      "│ waiting",
      "│ The action 'stuck' has timed out after 6ms.",
      "├ cmd    stuck   (cwd .)",
      "└ rerun  npx --no dag run ci.ts --only stuck",
      "summary: .dag/summary.md",
      "",
      "✖︎ hang, stuck, upload failed · ci.ts · wall 0.0s",
      "built 0 · cached 0 · failed 3 · skipped 0",
      "",
      "✖︎ hang     timed out · 0.0s · 1 line",
      "✖︎ stuck    timed out · 0.0s · 1 line",
      "✖︎ upload   0.0s",
      "",
      "rerun    npx --no dag run ci.ts --only hang,stuck,upload",
      "report   .dag/failures.md",
      "logs     .dag/logs/",
      "style: failures · every node's log inline: --output-style=grouped",
      "",
    ]);
  });

  test("a forced exit before the graph is built, and with a report it cannot write", async () => {
    const session = localRun("failures", createTestPorts().ports);
    const unwritable = localRun("failures", createTestPorts().ports);
    unwritable.files.writeFileSync = () => {
      throw new Error("EACCES: permission denied");
    };
    const jobs = [session.job(), unwritable.job()];
    session.processEvents.emit("exit");
    unwritable.processEvents.emit("exit");
    const atExit = {
      stdout: session.stdout(),
      report: session.report(),
      unwritable: unwritable.stdout(),
    };
    await Promise.all(jobs);
    assert.deepEqual(atExit, {
      stdout: ["", "◼︎ forced exit · report .dag/failures.md", ""],
      report: [
        "# Failures · ci.ts",
        "",
        "status: interrupted",
        "",
        "A forced exit stopped the run.",
        "",
        "No failures.",
        "",
        "Logs: .dag/logs/ · summary: .dag/summary.md",
        "",
      ],
      unwritable: [
        "[warning] dag: failures report off: EACCES: permission denied",
        "",
        "◼︎ forced exit · report .dag/failures.md",
        "",
      ],
    });
  });

  test("a forced exit while a run that threw is closing", RUN_TIMEOUT, async (t) => {
    const { ports, fs } = createTestPorts({ files: { "/cas/last-run.json": "{}" } });
    // The run throws once begun, and its close waits on the last run's durations, still being read.
    fs.ensureDir = async () => {
      throw new Error("EACCES: permission denied, mkdir '/cas'");
    };
    let read = () => {};
    const reading = new Promise<void>((resolve) => (read = resolve));
    let readStarted = false;
    const { readText } = fs;
    fs.readText = async (path) => {
      readStarted = true;
      await reading;
      return readText(path);
    };
    const session = localRun("failures", ports);
    const job = session.job().catch(errorMessage);
    await waitUntil(t, () => readStarted);
    session.processEvents.emit("exit");
    const atExit = { stdout: session.stdout(), report: session.report() };
    read();
    assert.deepEqual(
      { thrown: await job, ...atExit },
      {
        thrown: "EACCES: permission denied, mkdir '/cas'",
        stdout: [
          "ci.ts · 0 nodes · report .dag/failures.md",
          "",
          "◼︎ forced exit · report .dag/failures.md",
          "",
        ],
        report: [
          "# Failures · ci.ts",
          "",
          "status: interrupted",
          "",
          "A forced exit stopped the run.",
          "",
          "No failures.",
          "",
          "Logs: .dag/logs/ · summary: .dag/summary.md",
          "",
        ],
      },
    );
  });

  test("a cancel, then a forced exit while the post pass runs", RUN_TIMEOUT, async (t) => {
    let started = () => {};
    const releasing = new Promise<void>((resolve) => (started = resolve));
    let exit = (_: ExecResult) => {};
    const { ports } = createTestPorts({
      exec: {
        run: (cmd, opts) => {
          if (cmd[0] === "slow") {
            opts?.onOutput?.("compiling\n");
            return new Promise((resolve) =>
              signalOf(opts).addEventListener("abort", () => {
                const output = "compiling\n";
                resolve({ code: -1, stdout: output, stderr: "", output, ok: false });
              }),
            );
          }
          if (cmd[0] !== "release")
            return scriptedExec({ fast: { chunks: ["fast ok\n"], code: 0 } }).run(cmd, opts);
          opts?.onOutput?.("releasing\nhalf");
          started();
          // It ignores signals, so only a second Ctrl-C ends it.
          return new Promise((resolve) => (exit = resolve));
        },
      },
      clock: clockAt(),
    });
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        // The release waits for slow, which uses what fast set up. One try: the forced exit ends
        // the process, which the test cannot.
        const fast = workflow.task({
          name: "fast",
          cmd: ["fast"],
          post: { name: "release", cmd: ["release"], retry: "once" },
        });
        workflow.task({ name: "slow", cmd: ["slow"], deps: { fast }, cacheable: false });
      },
    });
    const session = localRun("failures", ports, { implementation });
    const controller = new AbortController();
    const job = session.job(controller.signal);
    await waitUntil(t, () => !!session.logs()[".dag/logs/slow.log"]);
    controller.abort();
    await releasing;
    session.processEvents.emit("exit");
    const atExit = { stdout: session.stdout(), report: session.report(), logs: session.logs() };
    exit({ code: 130, stdout: "", stderr: "", output: "", ok: false });
    await job;
    assert.deepEqual(atExit, {
      stdout: [
        "ci.ts · 3 nodes · report .dag/failures.md",
        "summary: .dag/summary.md",
        "post · 1 of 1 post steps owed",
        "",
        "◼︎ forced exit while release ran · report .dag/failures.md",
        "",
      ],
      report: [
        "# Failures · ci.ts",
        "",
        "status: interrupted · started 1970-01-01T00:00:00.000Z",
        "◼︎ cancelled, 1 node not run · built 1 · cached 0 · failed 0 · skipped 0 · cancelled 1",
        "",
        "A forced exit stopped the run while `release` ran.",
        "",
        "No failures.",
        "",
        "Logs: .dag/logs/ · summary: .dag/summary.md",
        "",
      ],
      logs: {
        ".dag/logs/fast.log": "fast ok\n",
        ".dag/logs/slow.log": "compiling\n",
        ".dag/logs/release.log": "releasing\nhalf\n",
      },
    });
  });

  test("a cancel, then a post pass that throws", RUN_TIMEOUT, async (t) => {
    const { ports } = createTestPorts({
      exec: {
        run: (cmd, opts) => {
          if (cmd[0] !== "slow") return scriptedExec({}).run(cmd, opts);
          opts?.onOutput?.("compiling\n");
          return new Promise((resolve) =>
            signalOf(opts).addEventListener("abort", () =>
              resolve({ code: -1, stdout: "", stderr: "", output: "", ok: false }),
            ),
          );
        },
      },
      clock: clockAt(),
    });
    let builds = 0;
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        // The post pass builds the graph again, which this workflow cannot.
        if (builds++ > 0) throw new Error("second build");
        // The release waits for slow, which uses what fast set up.
        const fast = workflow.task({
          name: "fast",
          cmd: ["fast"],
          post: { name: "release", cmd: ["release"] },
        });
        workflow.task({ name: "slow", cmd: ["slow"], deps: { fast }, cacheable: false });
      },
    });
    const session = localRun("failures", ports, { implementation });
    const controller = new AbortController();
    const job = session.job(controller.signal).catch(errorMessage);
    await waitUntil(t, () => !!session.logs()[".dag/logs/slow.log"]);
    controller.abort();
    assert.deepEqual(
      { thrown: await job, stdout: session.stdout(), report: session.report() },
      {
        thrown: "second build",
        stdout: [
          "ci.ts · 3 nodes · report .dag/failures.md",
          "summary: .dag/summary.md",
          "",
          "✖︎ errored: second build · ci.ts · wall 0.0s",
          "built 1 · cached 0 · failed 0 · skipped 0 · cancelled 2",
          "",
          "report   .dag/failures.md",
          "logs     .dag/logs/",
          "style: failures · every node's log inline: --output-style=grouped",
          "",
        ],
        report: [
          "# Failures · ci.ts",
          "",
          "status: errored · started 1970-01-01T00:00:00.000Z · wall 0.0s",
          "✖︎ errored: second build · built 1 · cached 0 · failed 0 · skipped 0 · cancelled 2",
          "",
          "```text",
          "second build",
          "```",
          "",
          "Logs: .dag/logs/ · summary: .dag/summary.md",
          "",
        ],
      },
    );
  });
});

describe("local session, live style", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setInterval"] }));
  afterEach(() => mock.timers.reset());

  test(
    "a run: its output before it begins, the footer under the scrollback, cache hits gathered",
    RUN_TIMEOUT,
    async () => {
      let now = 0;
      const { ports } = createTestPorts({
        files: {
          "/cas/last-run.json": JSON.stringify({
            durations: {
              lint: 1000,
              "test:a": 2000,
              "integration:packages-dagworkflows-e2e": 64_000,
            },
          }),
          "/cas.logs/k1.log": "checking src\nsrc/a.ts:1:1 error no-console\n",
          "/cas.logs/kb.log": "\x1b[1mbundled\x1b[22m 3 files\n",
        },
        clock: clockAt(() => now),
      });
      const session = localRun("live", ports, {
        schedulerOptions: { maxParallelism: 4, concurrencyLimits: { test: 1 } },
      });
      const { store } = session.runOptions;
      const nodeNamed = (name: string, more: Partial<Node> = {}): Node => {
        return { name, kind: name, deps: [], ...more };
      };
      const lint = nodeNamed("lint");
      const e2e = nodeNamed("integration:packages-dagworkflows-e2e");
      const testA = nodeNamed("test:a", { concurrencyGroup: "test" });
      const testB = nodeNamed("test:b", { concurrencyGroup: "test" });
      const build = nodeNamed("build");
      const docs = nodeNamed("docs", { deps: ["build"] });
      const requireAll = nodeNamed("require-all", { deps: ["lint"] });
      const deploy = nodeNamed("deploy", { deps: ["require-all"] });
      const fmt = nodeNamed("fmt");
      const pass = {
        banner: { title: "ci.ts · 9 nodes", lines: [] },
        title: "ci.ts",
        nodes: [lint, e2e, testA, testB, build, docs, requireAll, deploy, fmt],
      };
      const emitAt = async (occurredAt: number, execEvents: ExecEvent[]) => {
        now = occurredAt;
        execEvents.forEach((event) => store.onEvent(event));
        await store.report(pass);
        session.tick();
      };
      const done = (node: Node): ExecEvent =>
        resultOf(node, {
          actionKey: "",
          status: "done",
          outputs: "",
          contentHash: "h",
          elapsed: 1,
        });

      // The implementation prints as it builds the graph, before the run begins.
      session.streams.stdout.write("resolving workspace\n");
      const beforeBegin = session.writes.join("");
      store.begin(pass);
      // The run begins before its first event, as the runner's awaits make it.
      await new Promise(setImmediate);
      for (const node of [lint, e2e, testA]) {
        store.onEvent(dispatchOf(node));
        store.onEvent(startOf(node));
      }
      store.onEvent(dispatchOf(build));
      store.onEvent(outputOf(lint, "checking src\n"));
      store.onEvent(outputOf(e2e, "x".repeat(100)));
      store.onEvent(outputOf(testA, "ok 1 - parses\tthe feed\n"));
      await new Promise((written) =>
        session.streams.stderr.write("a stray stderr write\n", written),
      );
      session.streams.stdout.write("::debug::walking src\n");
      // Only a cache hit has settled, and the footer already has each node's last run.
      await emitAt(600, [
        dispatchOf(fmt),
        resultOf(fmt, { actionKey: "", status: "cached", outputs: "", contentHash: "h" }),
      ]);
      const midRun = await session.screen();
      // The terminal echoes a ^C at the cursor, the end of the status row.
      session.writes.push("^C");
      await emitAt(900, [
        failureOf(lint, "k1", "eslint . exited 1", { argv: ["eslint", "."], cwd: ".", code: 1 }),
        dispatchOf(requireAll),
        startOf(requireAll),
        failureOf(requireAll, "", "failed: lint"),
        resultOf(deploy, { actionKey: "", status: "dep-failed", dep: "require-all" }),
      ]);
      await emitAt(1500, [
        done(testA),
        dispatchOf(testB),
        startOf(testB),
        done(testB),
        done(e2e),
        resultOf(build, { actionKey: "kb", status: "cached", outputs: "", contentHash: "h" }),
        dispatchOf(docs),
        resultOf(docs, { actionKey: "", status: "cached", outputs: "", contentHash: "h" }),
      ]);
      await session.runOptions.store.close();
      assert.deepEqual(
        { beforeBegin, midRun, final: await session.screen(), logs: session.logs() },
        {
          beforeBegin: "resolving workspace\n",
          midRun: [
            "resolving workspace",
            "ci.ts · 9 nodes · logs .dag/logs/",
            "a stray stderr write",
            "✔︎ cached: fmt",
            "⠦ lint                     0.6s / ~1.0s",
            "⠦ integration:packages-da… 0.6s / ~1m0…",
            "⠦ test:a                   0.6s / ~2.0s",
            "⠦ build                    0.6s  check…",
            "· test:b                   queued: tes…",
            "[1/9] 4 running · 1 queued · ctrl-c ca…",
          ],
          final: [
            "resolving workspace",
            "ci.ts · 9 nodes · logs .dag/logs/",
            "a stray stderr write",
            "✔︎ cached: fmt",
            "✖︎ lint  exit 1 · 0.9s · 2 lines",
            "│ checking src",
            "│ src/a.ts:1:1 error no-console",
            "├ log    .dag/logs/lint.log",
            "├ cmd    eslint .   (cwd .)",
            "└ rerun  npx --no dag run ci.ts --only l",
            "int",
            "✖︎ require-all              failed (becau",
            "se lint failed)",
            "⏭︎ deploy                   skipped (beca",
            "use lint failed)",
            "✔︎ test:a                   1.5s",
            "✔︎ test:b                   0.0s",
            "✔︎ integration:packages-dagworkflows-e2e ",
            "1.5s",
            "✔︎ cached: build, docs",
            "",
            "✖︎ lint failed · ci.ts · wall 1.5s",
            "built 3 · cached 3 · failed 2 · skipped ",
            "1",
            "",
            "✖︎ lint   exit 1 · 0.9s · 2 lines   .dag/",
            "logs/lint.log",
            "  ✖︎ require-all failed because of it",
            "  ⏭︎ deploy skipped because of it",
            "",
            "rerun    npx --no dag run ci.ts --only l",
            "int",
            "report   .dag/failures.md   (hand this t",
            "o an agent)",
            "logs     .dag/logs/",
          ],
          logs: {
            ".dag/logs/lint.log": "checking src\n",
            ".dag/logs/integration/packages-dagworkflows-e2e.log": `${"x".repeat(100)}\n`,
            ".dag/logs/test/a.log": "ok 1 - parses\tthe feed\n",
            ".dag/logs/require-all.log": "",
            ".dag/logs/test/b.log": "",
            ".dag/logs/build.log": "bundled 3 files\n",
          },
        },
      );
    },
  );

  test("a cancel, then the post pass, and the terminal as it was left", RUN_TIMEOUT, async (t) => {
    let now = 0;
    let started = () => {};
    const slowStarted = new Promise<void>((resolve) => (started = resolve));
    const { ports } = createTestPorts({
      exec: {
        run: async (cmd, opts) => {
          if (cmd[0] !== "slow") {
            opts?.onOutput?.(`${cmd[0]} ok\n`);
            return { code: 0, stdout: "", stderr: "", output: `${cmd[0]} ok\n`, ok: true };
          }
          opts?.onOutput?.("compiling");
          started();
          return new Promise((resolve) =>
            signalOf(opts).addEventListener("abort", () => {
              opts?.onOutput?.("\nkilled by SIGINT\n");
              const output = "compiling\nkilled by SIGINT\n";
              resolve({ code: -1, stdout: "", stderr: "", output, ok: false });
            }),
          );
        },
      },
      clock: clockAt(() => now),
    });
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        // The release waits for slow, which uses what fast set up.
        const fast = workflow.task({
          name: "fast",
          cmd: ["fast"],
          post: { name: "teardown", cmd: ["teardown"] },
        });
        workflow.task({ name: "slow", cmd: ["slow"], deps: { fast }, cacheable: false });
      },
    });
    const session = localRun("live", ports, { implementation });
    const controller = new AbortController();
    const job = session.job(controller.signal);
    await slowStarted;
    await waitUntil(
      t,
      async () => (await session.screen()).includes("✔︎ fast     0.0s · 1 line"),
      session.tick,
    );
    now = 31_000;
    controller.abort();
    session.tick();
    const reportMidRun = session.report();
    const cancelling = await session.screen();
    const code = await job;
    // No redraw once the run has ended, and the terminal's writes are its own again.
    session.tick();
    session.streams.stderr.write("after the run\n");
    assert.deepEqual(
      {
        code,
        cancelling,
        final: await session.screen(),
        reportMidRun,
        report: session.report(),
        logs: session.logs(),
      },
      {
        code: 130,
        cancelling: [
          "ci.ts · 3 nodes · logs .dag/logs/",
          "✔︎ fast     0.0s · 1 line",
          "⠋ slow     31.0s  killed by SIGINT",
          "· teardown waits on slow",
          "[1/3] cancelling: waiting for 1 runnin…",
        ],
        final: [
          "ci.ts · 3 nodes · logs .dag/logs/",
          "✔︎ fast     0.0s · 1 line",
          "◼︎ slow     cancelled after 31.0s",
          "summary: .dag/summary.md",
          // Owed, since fast started.
          "post · 1 of 1 post steps owed",
          "✔︎ teardown 0.0s · 1 line",
          "summary: .dag/summary.md",
          "",
          "◼︎ cancelled, 1 node not run · ci.ts · wa",
          "ll 31.0s",
          "built 2 · cached 0 · failed 0 · skipped ",
          "0 · cancelled 1",
          "",
          "logs     .dag/logs/",
          "after the run",
        ],
        reportMidRun: [
          "# Failures · ci.ts",
          "",
          "status: running",
          "",
          "No failures so far.",
          "",
          "Logs: .dag/logs/ · summary: .dag/summary.md",
          "",
        ],
        report: [
          "# Failures · ci.ts",
          "",
          "status: cancelled · started 1970-01-01T00:00:00.000Z · wall 31.0s",
          "◼︎ cancelled, 1 node not run · built 2 · cached 0 · failed 0 · skipped 0 · cancelled 1",
          "",
          "No failures.",
          "",
          "Logs: .dag/logs/ · summary: .dag/summary.md",
          "",
        ],
        logs: {
          ".dag/logs/fast.log": "fast ok\n",
          ".dag/logs/slow.log": "compiling\nkilled by SIGINT\n",
          ".dag/logs/teardown.log": "teardown ok\n",
        },
      },
    );
  });

  test("a crowd, in color with links, then a cancel", async () => {
    let now = 0;
    const { ports } = createTestPorts({
      files: { "/cas.logs/k1.log": "checking src\nsrc/a.ts:1:1 error no-console\n" },
      clock: clockAt(() => now),
    });
    // supports-hyperlinks reads this as the session is made, as a terminal with links would.
    process.env.FORCE_HYPERLINK = "1";
    const session = localRun(
      "live",
      ports,
      { schedulerOptions: { maxParallelism: 6, concurrencyLimits: { io: 1 } } },
      { hasColors: () => true },
    );
    delete process.env.FORCE_HYPERLINK;
    const { store } = session.runOptions;
    const nodeNamed = (name: string, more: Partial<Node> = {}): Node => {
      return { name, kind: name, deps: [], ...more };
    };
    const [a1, a2, a3, a4, a5, a6] = [
      nodeNamed("a1"),
      nodeNamed("a2"),
      nodeNamed("a3"),
      nodeNamed("a4"),
      nodeNamed("a5"),
      nodeNamed("a6"),
    ];
    const [b, c, w] = [nodeNamed("b"), nodeNamed("c"), nodeNamed("w", { deps: ["b", "c", "a6"] })];
    const g = nodeNamed("g", { deps: ["a1"] });
    const io = { deps: ["a6"], concurrencyGroup: "io" };
    const [x, y] = [nodeNamed("x", io), nodeNamed("y", io)];
    // The last is skipped because the one before it was.
    const skipped = [1, 2, 3, 4, 5, 6].map((i) =>
      nodeNamed(`s${i}`, { deps: [i < 6 ? "a1" : "s5"] }),
    );
    const pass = {
      banner: { title: "ci.ts · 18 nodes", lines: [] },
      title: "ci.ts",
      nodes: [a1, a2, a3, a4, a5, a6, w, b, c, g, x, y, ...skipped],
    };
    const emitAt = async (occurredAt: number, execEvents: ExecEvent[]) => {
      now = occurredAt;
      execEvents.forEach((event) => store.onEvent(event));
      await store.report(pass);
    };
    const started = (node: Node): ExecEvent[] => [dispatchOf(node), startOf(node)];
    const done = (node: Node): ExecEvent =>
      resultOf(node, { actionKey: "", status: "done", outputs: "", contentHash: "h", elapsed: 1 });
    const cancelled = (node: Node, actionKey = ""): ExecEvent =>
      resultOf(node, { actionKey, status: "cancelled" });
    const screenAt = async (occurredAt: number) => {
      now = occurredAt;
      session.tick();
      return await session.screen();
    };

    store.begin(pass);
    await new Promise(setImmediate);
    // A second passes as the graph is built: no footer before the first node is dispatched.
    const beforeDispatch = await screenAt(1000);
    // Started last to first, so the earliest in flight is the last in the graph.
    for (const [i, node] of [a6, a5, a4, a3, a2, a1].entries())
      await emitAt(1000 + i * 10, started(node));
    store.onEvent(outputOf(a6, "ok\tparses\u00ad the feed\n"));
    store.onEvent(outputOf(a5, "\x1b[32m50%\x1b[39m"));
    store.onEvent(outputOf(a4, "built\n\n::debug::walking src"));
    store.onEvent(outputOf(a3, "linked\n  "));
    const beforeFirstDraw = await screenAt(1300);
    await screenAt(1600);
    const crowded = session.footer();
    await emitAt(1900, [
      failureOf(
        a1,
        "k1",
        'run "a1": output "report" (lint.xml) was not written. Write it at out.report before the action returns.',
        {
          argv: ["eslint", "."],
          cwd: ".",
          code: 0,
        },
      ),
      ...started(g),
      failureOf(g, "", "failed: a1"),
      ...skipped.map((node) => {
        const [dep] = node.deps;
        assert.ok(dep, "dep");
        return resultOf(node, { actionKey: "", status: "dep-failed", dep });
      }),
      ...[a2, a3, a4, a5].map(done),
      ...started(b),
    ]);
    // Stray writes that end no line: each keeps a line of its own.
    session.streams.stdout.write(Buffer.from("linking"));
    const waiting = await screenAt(2200);
    session.streams.stdout.write("building");
    await emitAt(2300, [done(a6), ...started(x)]);
    store.onEvent(outputOf(x, "uploading"));
    await screenAt(2400);
    const queued = session.footer();
    store.cancel();
    await emitAt(2500, [
      done(b),
      dispatchOf(c),
      resultOf(c, { actionKey: "", status: "cached", outputs: "", contentHash: "h" }),
      cancelled(x, "kx"),
      cancelled(y),
      cancelled(w),
    ]);
    // As the runner begins a post pass that owes nothing.
    store.begin({ title: "ci.ts · post", nodes: [] });
    await store.close();
    // What the frames printed above the footer, escapes and all.
    const printed = session.writes
      .join("")
      .replace(/\x1b\[\?2026[hl]|\r(?:\x1b\[\d+A)?\x1b\[J|\x1b\[\?7l[^]*?\r\x1b\[\?7h/g, "")
      .split("\n");
    const paint = (format: Parameters<typeof styleText>[0]) => (text: string) =>
      styleText(format, text, { validateStream: false });
    const [bold, dim, red, green, yellow, gray, cyan] = [
      paint("bold"),
      paint("dim"),
      paint("red"),
      paint("green"),
      paint("yellow"),
      paint("gray"),
      paint("cyan"),
    ];
    const link = (path: string) =>
      `\x1b]8;;${pathToFileURL(resolve(path)).href}\x1b\\${path}\x1b]8;;\x1b\\`;
    const titled = ["ci.ts · 18 nodes · logs .dag/logs/"];
    assert.deepEqual(
      { beforeDispatch, beforeFirstDraw, crowded, waiting, queued, printed },
      {
        beforeDispatch: titled,
        beforeFirstDraw: titled,
        crowded: [
          `${cyan("⠦")} a6 0.6s  ${dim("ok parses the feed")}`,
          `${cyan("⠦")} a5 0.6s  ${dim("50%")}`,
          `${cyan("⠦")} a4 0.6s  ${dim("built")}`,
          `${cyan("⠦")} a3 0.6s  ${dim("linked")}`,
          dim("  +2 more running"),
          "[0/18] 6 running · 2 queued · ctrl-c c…",
        ],
        waiting: [
          ...titled,
          "✖︎ a1  0.8s · 2 lines",
          "│ checking src",
          "│ src/a.ts:1:1 error no-console",
          '│ run "a1": output "report" (lint.xml) w',
          "as not written. Write it at out.report b",
          "efore the action returns.",
          "├ log    .dag/logs/a1.log",
          "├ cmd    eslint .   (cwd .)",
          "└ rerun  npx --no dag run ci.ts --only a",
          "1",
          "✖︎ g  failed (because a1 failed)",
          ...skipped.map((node) => `⏭︎ ${node.name} skipped (because a1 failed)`),
          ...["a2", "a3", "a4", "a5"].map((node) => `✔︎ ${node} 0.9s`),
          "linking",
          "⠹ a6 1.2s  ok parses the feed",
          "⠹ b  0.3s",
          "· c  queued: 2/6 running",
          "· w  waits on b, c +1",
          "[12/18 ✖︎2] 2 running · 1 queued · ctrl…",
        ],
        queued: [
          `${cyan("⠼")} b 0.5s`,
          `${cyan("⠼")} x 0.1s  ${dim("uploading")}`,
          dim("· c queued: 2/6 running"),
          dim("· y queued: io 1/1"),
          "[13/18 ✖︎2] 2 running · 2 queued · ctrl…",
        ],
        printed: [
          `${bold("ci.ts · 18 nodes")} · logs ${link(".dag/logs")}/`,
          `${red("✖︎")} ${bold("a1")}  ${dim("0.8s · 2 lines")}`,
          `${dim("│")} checking src`,
          `${dim("│")} src/a.ts:1:1 error no-console`,
          `${dim("│")} ${red('run "a1": output "report" (lint.xml) was not written. Write it at out.report before the action returns.')}`,
          `${dim("├ log    ")}${link(".dag/logs/a1.log")}`,
          `${dim("├ cmd    ")}eslint .   ${dim("(cwd .)")}`,
          `${dim("└ rerun  ")}npx --no dag run ci.ts --only a1`,
          `${red("✖︎")} g  ${dim("failed (because a1 failed)")}`,
          ...skipped.map(
            (node) => `${yellow("⏭︎")} ${node.name} ${dim("skipped (because a1 failed)")}`,
          ),
          ...["a2", "a3", "a4", "a5"].map((node) => `${green("✔︎")} ${node} ${dim("0.9s")}`),
          "linking",
          "building",
          `${green("✔︎")} a6 ${dim("1.3s")}`,
          `${green("✔︎")} b  ${dim("0.6s")}`,
          `${green("✔︎")} ${dim("cached:")} c`,
          `${gray("◼︎")} x  ${dim("cancelled after 0.2s")}`,
          "",
          `${bold("✖︎ a1 failed")} · ci.ts · wall 1.5s`,
          dim("built 6 · cached 1 · failed 2 · skipped 6 · cancelled 3"),
          "",
          `${red("✖︎")} a1   0.8s · 2 lines   ${link(".dag/logs/a1.log")}`,
          `  ${red("✖︎")} g failed because of it`,
          `  ${yellow("⏭︎")} s1, s2, s3, s4, s5 +1 skipped because of it`,
          "",
          `${dim("rerun    ")}npx --no dag run ci.ts --only a1`,
          `${dim("report   ")}${link(".dag/failures.md")}${dim("   (hand this to an agent)")}`,
          `${dim("logs     ")}${link(".dag/logs")}/`,
          "",
        ],
      },
    );
  });

  test(
    "a frame's bytes, and a stopped post step's row afresh in the post pass",
    RUN_TIMEOUT,
    async () => {
      let now = 0;
      const { ports } = createTestPorts({ clock: clockAt(() => now) });
      const session = localRun("live", ports);
      const { store } = session.runOptions;
      const save: Node = { name: "save", kind: "save", deps: [] };
      const main = { title: "ci.ts", nodes: [save] };
      const post = { title: "ci.ts · post", nodes: [save] };
      const start = () => {
        store.onEvent(dispatchOf(save));
        store.onEvent(startOf(save));
      };
      store.begin(main);
      await new Promise(setImmediate);
      start();
      store.onEvent(outputOf(save, "saving\n"));
      store.cancel();
      store.onEvent(outputOf(save, "killed by SIGINT\n"));
      now = 600;
      session.tick();
      const stopping = session.writes.at(-1);
      store.onEvent(resultOf(save, { actionKey: "ks", status: "cancelled" }));
      await store.report(main);
      store.begin(post);
      await new Promise(setImmediate);
      start();
      now = 1200;
      session.tick();
      const again = await session.screen();
      await store.close();
      const titled = ["ci.ts · logs .dag/logs/"];
      const [SYNC, SYNCED, WRAP_OFF, WRAP_ON] = [
        "\x1b[?2026h",
        "\x1b[?2026l",
        "\x1b[?7l",
        "\x1b[?7h",
      ];
      assert.deepEqual(
        { stopping, again },
        {
          // One synchronized write: the scrollback, then the rows unwrapped, ending in a return.
          stopping: [
            SYNC,
            "ci.ts · logs .dag/logs/\n",
            WRAP_OFF,
            "⠦ save 0.6s  killed by SIGINT\n[0/1] cancelling: waiting for 1 runnin…\r",
            WRAP_ON,
            SYNCED,
          ].join(""),
          again: [
            ...titled,
            "◼︎ save cancelled after 0.6s",
            "ci.ts · post",
            "⠹ save 0.6s",
            "[0/1] cancelling: waiting for 1 runnin…",
          ],
        },
      );
    },
  );
  test("the footer in other windows", async () => {
    let now = 0;
    const { ports } = createTestPorts({ clock: clockAt(() => now) });
    const session = localRun("live", ports);
    const { store } = session.runOptions;
    const nodes = Array.from({ length: 9 }, (_, i): Node => {
      return { name: `node${i + 1}`, kind: "node", deps: [] };
    });
    store.begin({ title: "ci.ts", nodes });
    await new Promise(setImmediate);
    for (const nodeNamed of nodes) {
      store.onEvent(dispatchOf(nodeNamed));
      store.onEvent(startOf(nodeNamed));
    }
    const [first] = nodes;
    assert.ok(first, "node");
    store.onEvent(
      outputOf(first, "src/settings/notifications/email-digest-preferences.test.tsx passed\n"),
    );
    now = 600;
    const sizedAs = (columns?: number, rows?: number) => {
      Object.assign(session.streams.stdout, { columns, rows });
      session.tick();
      return session.footer();
    };
    // Three columns to spare are too few for a line; a size unknown is taken as 80×24.
    const footers = { narrow: sizedAs(17, 12), unsized: sizedAs(), wide: sizedAs(120, 50) };
    await store.close();
    const rows = (names: string[]) => names.map((node) => `⠦ ${node} 0.6s`);
    // At most 72 columns and 8 rows, at most half the window's.
    const capped = [
      "⠦ node1 0.6s  src/settings/notifications/email-digest-preferences.test.…",
      ...rows(["node2", "node3", "node4", "node5", "node6"]),
      "  +3 more running",
      "[0/9] 9 running · ctrl-c cancels",
    ];
    assert.deepEqual(footers, {
      narrow: [
        ...rows(["node1", "node2", "node3", "node4"]),
        "  +5 more running",
        "[0/9] 9 running…",
      ],
      unsized: capped,
      wide: capped,
    });
  });
});
