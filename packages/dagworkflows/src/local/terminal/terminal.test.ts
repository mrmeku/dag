import {
  createMemoryFileSystem,
  type ExecutionEvent,
  type JsonValue,
  type Node,
  type NodeResult,
} from "@mrmeku/dagraph";
import xterm from "@xterm/headless";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import type { OutputStyle } from "../../config/index.ts";
import { warningCommand } from "../../github-workflow-commands/index.ts";
import { scopeOf, type Pass } from "../../kernel/index.ts";
import { createRecordingHost } from "../../recording/index.ts";
import { createRunStore } from "../../run-store/index.ts";
import type { WriteStreams } from "../../wiring/index.ts";
import { createTerminal, outputStyleFor } from "./index.ts";

const nodeNamed = (name: string, deps: string[] = []): Node => ({ name, kind: name, deps });
type Settled<R = NodeResult> = R extends unknown ? Omit<R, "name"> : never;
const started = (node: Node): ExecutionEvent[] => [
  { type: "dispatch", node: node.name, occurredAt: 0 },
  { type: "start", node: node.name, occurredAt: 0 },
];
const printed = (node: Node, chunk: string): ExecutionEvent => ({
  type: "output",
  node: node.name,
  chunk,
  occurredAt: 0,
});
const settledAs = (node: Node, result: Settled): ExecutionEvent => ({
  type: "result",
  node: node.name,
  result: { name: node.name, ...result },
  occurredAt: 0,
});
const built = (node: Node) =>
  settledAs(node, {
    status: "succeeded",
    details: {
      actionKey: `k-${node.name}`,
      entry: { outputs: {}, contentHash: "h", outputHashes: {} },
      actionRan: true,
      elapsed: 1,
    },
  });
const failed = (node: Node, message: string, cause?: JsonValue) =>
  settledAs(node, {
    status: "failed",
    error: { name: "Error", message, ...(cause !== undefined && { cause }) },
    details: { actionKey: `k-${node.name}`, elapsed: 1 },
  });
const exited = (argv: string[], code: number): JsonValue => ({
  argv,
  cwd: ".",
  ended: "exited",
  code,
});
const skippedFor = (node: Node, dep: string, rootCause = dep) =>
  settledAs(node, { status: "dep-failed", dep, rootCauses: [rootCause] });
const passOf = (nodes: Node[], file = "ci.ts"): Pass => ({
  banner: {
    title: `${file} · ${scopeOf(nodes.length, undefined, nodes.length)}`,
    lines: nodes.map((node) => node.name),
  },
  title: file,
  nodes,
  rerunCommand: `npx --no dag run ${file}`,
});

/**
 * The terminal in `style` on a 40×12 stdout double recording its writes, the recording host as the
 * local host, and a store over memory files; each node that started has a log file, as the log
 * files give one.
 */
function terminalRun(
  style: OutputStyle,
  opts: { workflowFile?: string; failuresReportPath?: string } = {},
  stdout: Partial<WriteStreams["stdout"]> = {},
) {
  const writes: string[] = [];
  const write = (chunk: string | Uint8Array) => writes.push(String(chunk)) > 0;
  const streams: WriteStreams = {
    stdout: { write, columns: 40, rows: 12, ...stdout },
    stderr: { write },
  };
  const recorded = createRecordingHost();
  const logged = new Set<string>();
  const { listener } = createTerminal({
    style,
    files: {
      logFile: (name) =>
        logged.has(name) ? `.dag/logs/${name.replaceAll(":", "/")}.log` : undefined,
      workflowFile: opts.workflowFile ?? "ci.ts",
      failuresReportPath: opts.failuresReportPath ?? ".dag/failures.md",
      logDir: ".dag/logs",
      summaryPath: ".dag/summary.md",
    },
    streams,
    clock: { epochMilliseconds: () => 0 },
    host: recorded.host,
  });
  const store = createRunStore({
    fs: createMemoryFileSystem(),
    durationsFile: "/durations/ci.ts.json",
    listeners: [listener, { immediate: { start: ({ node }) => void logged.add(node.name) } }],
  });
  const emit = (events: ExecutionEvent[]) => events.forEach(store.onEvent);
  return {
    store,
    emit,
    recorded,
    writes,
    stdout: () => writes.join("").split("\n"),
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
  const lines = Array.from({ length: buffer.length }, (_, i) => {
    const line = buffer.getLine(i);
    assert.ok(line, `line ${i}`);
    return line.translateToString(true);
  });
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

const RECAP_END = ["report   .dag/failures.md", "logs     .dag/logs/"];
const STYLE_LINE = "style: failures · every node's log inline: --output-style=grouped";

describe("the terminal's style", () => {
  test("a style given wins; else CI gives grouped over an agent, an agent failures, a terminal live unless dumb", () => {
    const facts = { isCI: false, isAgent: false, isTerminal: false, term: undefined };
    assert.deepEqual(
      {
        ciAgent: outputStyleFor(undefined, { ...facts, isCI: true, isAgent: true }),
        given: outputStyleFor("live", { ...facts, isCI: true, isAgent: true }),
        agent: outputStyleFor(undefined, { ...facts, isAgent: true }),
        terminal: outputStyleFor(undefined, { ...facts, isTerminal: true, term: "xterm" }),
        dumb: outputStyleFor(undefined, { ...facts, isTerminal: true, term: "dumb" }),
        piped: outputStyleFor(undefined, facts),
      },
      {
        ciAgent: "grouped",
        given: "live",
        agent: "failures",
        terminal: "live",
        dumb: "grouped",
        piped: "grouped",
      },
    );
  });

  test("the first banner says where the style points: the report, the logs, or neither in grouped", async () => {
    const nodes = ["lint", "test", "build", "docs"].map((name) => nodeNamed(name));
    const pass = passOf(nodes);
    const firstLines = await Promise.all(
      (["failures", "live", "grouped"] as const).map(async (style) => {
        const run = terminalRun(style, { failuresReportPath: "out/f.md" });
        run.store.begin(pass);
        await run.store.close();
        if (style === "grouped") return run.recorded.log[0];
        return (style === "live" ? await screen(run.writes) : run.stdout())[0];
      }),
    );
    assert.deepEqual(firstLines, [
      "ci.ts · 4 nodes · report out/f.md",
      "ci.ts · 4 nodes · logs .dag/logs/",
      { title: "ci.ts · 4 nodes", lines: ["lint", "test", "build", "docs"] },
    ]);
  });
});

describe("the grouped style", () => {
  test("GitHub's groups, each warning as the local host prints one, two on a line too, and the local rerun command with the file quoted", async () => {
    const lint = nodeNamed("lint");
    const pass = passOf([lint], "ci flows.ts");
    const run = terminalRun("grouped", { workflowFile: "ci flows.ts" });
    run.store.begin(pass);
    run.emit(started(lint));
    run.emit([
      printed(
        lint,
        `checking\n${warningCommand("lint", "old flag")}\r${warningCommand("lint", "no cache")}\n`,
      ),
    ]);
    run.emit([failed(lint, "lint exited 1", exited(["lint"], 1))]);
    await run.store.finish(pass, await run.store.report(pass));
    assert.deepEqual(run.recorded.log, [
      { title: "ci flows.ts · 1 node", lines: ["lint"] },
      "▷ lint",
      {
        title: "✖︎ lint (1ms)",
        lines: [
          "checking",
          "[warning] lint: old flag",
          "[warning] lint: no cache",
          "── error ──",
          "lint exited 1",
        ],
      },
      "",
      "✖︎ lint failed · ci flows.ts · built 0 · cached 0 · failed 1 · skipped 0 · wall 1ms",
      "failed: lint",
      "reproduce: npx --no dag run 'ci flows.ts' --only lint",
    ]);
  });
});

describe("the failures style", () => {
  test("failures as blocks, later ones a line, what they brought down in the recap; no colours on a terminal that has them", async () => {
    const [install, lint, build] = [
      nodeNamed("install"),
      nodeNamed("lint", ["install"]),
      nodeNamed("build", ["install"]),
    ];
    const requireAll = nodeNamed("require-all", ["lint", "build"]);
    const deploy = nodeNamed("deploy:site", ["require-all"]);
    const upload = nodeNamed("upload", ["lint"]);
    const pack = nodeNamed("pack");
    const pass = passOf([install, lint, build, requireAll, deploy, upload, pack]);
    const run = terminalRun("failures", {}, { isTTY: true, hasColors: () => true });
    const errors = (first: number, last: number) =>
      Array.from({ length: last - first + 1 }, (_, i) => `src/a${first + i}.ts:1:1\terror`);
    run.store.begin(pass);
    run.emit([...started(install), built(install), ...started(pack)]);
    run.emit([printed(pack, `packed\n${"=".repeat(600)}\n`)]);
    run.emit([
      failed(
        pack,
        'output "tarball" (pkg.tgz) was not written. Write it at out.tarball before the action returns.',
        exited(["pack"], 0),
      ),
    ]);
    run.emit([...started(lint), ...started(build)]);
    run.emit([
      printed(lint, ["linting", ...errors(1, 70), "\x1b[1m70 problems\x1b[22m"].join("\n")),
    ]);
    run.emit([
      failed(lint, "lint exited 1", exited(["lint"], 1)),
      built(build),
      ...started(upload),
    ]);
    run.emit([printed(upload, "ECONNREFUSED 127.0.0.1:9000\n")]);
    run.emit([failed(upload, "upload exited 3", exited(["upload"], 3)), ...started(requireAll)]);
    run.emit([failed(requireAll, "failed: lint"), skippedFor(deploy, "require-all")]);
    await run.store.close();
    assert.deepEqual(run.stdout(), [
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
      "✖︎ require-all   0.0s   .dag/logs/require-all.log",
      "",
      "✖︎ lint, require-all, upload and 1 more failed · ci.ts · wall 0.0s",
      "built 2 · cached 0 · failed 4 · skipped 1",
      "",
      "✖︎ lint          exit 1 · 0.0s · 72 lines   .dag/logs/lint.log",
      "✖︎ require-all   0.0s   .dag/logs/require-all.log",
      "  ⏭︎ deploy:site skipped because of it",
      "✖︎ upload        exit 3 · 0.0s · 1 line   .dag/logs/upload.log",
      "✖︎ 1 more, in the report",
      "",
      "rerun    npx --no dag run ci.ts --only lint,require-all,upload,pack",
      ...RECAP_END,
      STYLE_LINE,
      "",
    ]);
  });

  test("thirty failing nodes of sixty, within an agent's budget", async () => {
    const testLine = (i: number, j: number) =>
      `pkg${i} test line ${j} with some typical output text here`;
    const install = nodeNamed("install");
    const name = (i: number) => `packages/pkg${i}:test`;
    const packages = Array.from({ length: 30 }, (_, i) => ({
      test: nodeNamed(name(i), ["install"]),
      build: nodeNamed(`packages/pkg${i}:build`, [name(i)]),
    }));
    const tests = packages.map(({ test }) => test);
    const pass = passOf([install, ...packages.flatMap(({ test, build }) => [test, build])]);
    const run = terminalRun("failures");
    run.store.begin(pass);
    run.emit([...started(install), built(install)]);
    for (const [i, node] of tests.entries()) {
      run.emit(started(node));
      run.emit([
        printed(node, Array.from({ length: 30 }, (_, j) => `${testLine(i, j + 1)}\n`).join("")),
      ]);
      run.emit([failed(node, `test ${i} exited 1`, exited(["test", String(i)], 1))]);
    }
    for (const [i, { build }] of packages.entries()) run.emit([skippedFor(build, name(i))]);
    await run.store.close();
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
    const stdout = run.stdout();
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
          `rerun    npx --no dag run ci.ts --only ${tests.map((node) => node.name).join(",")}`,
          ...RECAP_END,
          "1 line left out · all of it in .dag/failures.md",
          STYLE_LINE,
          "",
        ],
      },
    );
  });

  test("warnings have a budget of their own: a node's first few, then how many more and where, so a failure's block keeps its budget", async () => {
    const noisy = nodeNamed("noisy");
    const chatty = nodeNamed("chatty", ["noisy"]);
    const lint = nodeNamed("lint", ["chatty"]);
    const pass = passOf([noisy, chatty, lint]);
    const loud = "x".repeat(300);
    const warnings = (name: string, messages: string[]) =>
      messages.map((message) => `${warningCommand(name, message)}\n`).join("");
    const run = terminalRun("failures");
    run.store.begin(pass);
    run.emit(started(noisy));
    run.emit([
      printed(
        noisy,
        warnings(
          "noisy",
          Array.from({ length: 400 }, (_, i) => `w${i + 1}`),
        ),
      ),
    ]);
    run.emit([built(noisy), ...started(chatty)]);
    run.emit([printed(chatty, warnings("chatty", [loud, loud, loud]))]);
    run.emit([built(chatty), ...started(lint), printed(lint, "src/a.ts: error\n")]);
    run.emit([failed(lint, "lint exited 1", exited(["lint"], 1))]);
    await run.store.close();
    assert.deepEqual(run.stdout(), [
      "ci.ts · 3 nodes · report .dag/failures.md",
      "[warning] noisy: w1",
      "[warning] noisy: w2",
      "[warning] noisy: w3",
      "397 more warnings in .dag/logs/noisy.log",
      `[warning] chatty: ${loud}`,
      `[warning] chatty: ${loud}`,
      "✖︎ lint  exit 1 · 0.0s · 1 line",
      "│ src/a.ts: error",
      "├ log    .dag/logs/lint.log",
      "├ cmd    lint   (cwd .)",
      "└ rerun  npx --no dag run ci.ts --only lint",
      "",
      "✖︎ lint failed · ci.ts · wall 0.0s",
      "built 2 · cached 0 · failed 1 · skipped 0",
      "",
      "✖︎ lint   exit 1 · 0.0s · 1 line   .dag/logs/lint.log",
      "",
      "rerun    npx --no dag run ci.ts --only lint",
      ...RECAP_END,
      "1 warning line left out · each in its node's log in .dag/logs/",
      STYLE_LINE,
      "",
    ]);
  });

  test("a forced exit names the nodes it stopped, if any, and where the report is", async () => {
    const lint = nodeNamed("lint");
    const build = nodeNamed("build");
    const pass = passOf([lint, build]);
    const run = terminalRun("failures");
    run.store.begin(pass);
    run.emit([...started(lint), ...started(build), printed(lint, "src/a.ts: error\n")]);
    run.emit([failed(lint, "lint exited 1", exited(["lint"], 1))]);
    await run.store.report(pass);
    run.store.interrupt();
    const beforeGraph = terminalRun("failures");
    beforeGraph.store.interrupt();
    assert.deepEqual(
      { whileRunning: run.stdout(), beforeGraph: beforeGraph.stdout() },
      {
        whileRunning: [
          "ci.ts · 2 nodes · report .dag/failures.md",
          "✖︎ lint  exit 1 · 0.0s · 1 line",
          "│ src/a.ts: error",
          "├ log    .dag/logs/lint.log",
          "├ cmd    lint   (cwd .)",
          "└ rerun  npx --no dag run ci.ts --only lint",
          "",
          "◼︎ forced exit while build ran · report .dag/failures.md",
          "",
        ],
        beforeGraph: ["", "◼︎ forced exit · report .dag/failures.md", ""],
      },
    );
  });

  test("a run that errors before any node runs", async () => {
    const run = terminalRun("failures");
    await run.store.close(new Error("bad config\n    at ci.ts:3"));
    assert.deepEqual(run.stdout(), [
      "",
      "✖︎ errored: bad config · ci.ts",
      "",
      ...RECAP_END,
      STYLE_LINE,
      "",
    ]);
  });
});

describe("every style", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setInterval"] }));
  afterEach(() => mock.timers.reset());

  test("a task's warnings show once in each style, in place of the raw line in grouped", async () => {
    const lint = nodeNamed("lint");
    const upload = nodeNamed("upload", ["lint"]);
    const pass = passOf([lint, upload]);
    const outputs = await Promise.all(
      (["live", "failures", "grouped"] as const).map(async (style) => {
        const run = terminalRun(style);
        run.store.begin(pass);
        run.emit(started(lint));
        run.emit([printed(lint, `checking\n${warningCommand("lint", "old flag")}\n`)]);
        run.emit([failed(lint, "lint exited 1", exited(["lint"], 1)), ...started(upload)]);
        run.emit([printed(upload, `uploading\n${warningCommand("upload", "no files")}\n`)]);
        run.emit([built(upload)]);
        await run.store.finish(pass, await run.store.report(pass));
        await run.store.close();
        const shown =
          style === "live"
            ? await screen(run.writes)
            : style === "failures"
              ? run.stdout()
              : run.recorded.log;
        return [style, shown] as const;
      }),
    );
    assert.deepEqual(Object.fromEntries(outputs), {
      live: [
        "ci.ts · 2 nodes · logs .dag/logs/",
        "✖︎ lint  exit 1 · 0.0s · 2 lines",
        "│ checking",
        "├ log    .dag/logs/lint.log",
        "├ cmd    lint   (cwd .)",
        "└ rerun  npx --no dag run ci.ts --only l",
        "int",
        "[warning] lint: old flag",
        "✔︎ upload 0.0s · 2 lines",
        "[warning] upload: no files",
        "",
        "✖︎ lint failed · ci.ts · wall 0.0s",
        "built 1 · cached 0 · failed 1 · skipped ",
        "0",
        "",
        "✖︎ lint   exit 1 · 0.0s · 2 lines   .dag/",
        "logs/lint.log",
        "",
        "rerun    npx --no dag run ci.ts --only l",
        "int",
        "report   .dag/failures.md   (hand this t",
        "o an agent)",
        "logs     .dag/logs/",
      ],
      failures: [
        "ci.ts · 2 nodes · report .dag/failures.md",
        "✖︎ lint  exit 1 · 0.0s · 2 lines",
        "│ checking",
        "├ log    .dag/logs/lint.log",
        "├ cmd    lint   (cwd .)",
        "└ rerun  npx --no dag run ci.ts --only lint",
        "[warning] lint: old flag",
        "[warning] upload: no files",
        "",
        "✖︎ lint failed · ci.ts · wall 0.0s",
        "built 1 · cached 0 · failed 1 · skipped 0",
        "",
        "✖︎ lint   exit 1 · 0.0s · 2 lines   .dag/logs/lint.log",
        "",
        "rerun    npx --no dag run ci.ts --only lint",
        ...RECAP_END,
        STYLE_LINE,
        "",
      ],
      grouped: [
        { title: "ci.ts · 2 nodes", lines: ["lint", "upload"] },
        "▷ lint",
        {
          title: "✖︎ lint (1ms)",
          lines: ["checking", "[warning] lint: old flag", "── error ──", "lint exited 1"],
        },
        "▷ upload",
        { title: "✔︎ upload (1ms)", lines: ["uploading", "[warning] upload: no files"] },
        "",
        "✖︎ lint failed · ci.ts · built 1 · cached 0 · failed 1 · skipped 0 · wall 1ms",
        "failed: lint",
        "reproduce: npx --no dag run ci.ts --only lint",
      ],
    });
  });
});
