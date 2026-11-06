import {
  createMemoryFileSystem,
  type ExecutionEvent,
  type JsonValue,
  type Node,
  type NodeResult,
} from "@mrmeku/dagraph";
import xterm from "@xterm/headless";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { pathToFileURL } from "node:url";
import { styleText } from "node:util";
import { LIVE_FRAME_MS } from "../../config/index.ts";
import { warningCommand } from "../../github-workflow-commands/index.ts";
import type { Pass } from "../../kernel/index.ts";
import { createRecordingHost } from "../../recording/index.ts";
import { createRunStore } from "../../run-store/index.ts";
import type { WriteStreams } from "../../wiring/index.ts";
import { createTerminal } from "./index.ts";
import { truncate } from "./live.ts";

const nodeNamed = (name: string, more: Partial<Node> = {}): Node => ({
  name,
  kind: name,
  deps: [],
  ...more,
});
type Settled<R = NodeResult> = R extends unknown ? Omit<R, "name"> : never;
const dispatched = (node: Node): ExecutionEvent => ({
  type: "dispatch",
  node: node.name,
  occurredAt: 0,
});
const pending = (node: Node): ExecutionEvent => ({
  type: "pending",
  node: node.name,
  occurredAt: 0,
});
const start = (node: Node): ExecutionEvent => ({ type: "start", node: node.name, occurredAt: 0 });
const started = (node: Node): ExecutionEvent[] => [dispatched(node), start(node)];
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
const entry = { outputs: {}, contentHash: "h", outputHashes: {} };
const built = (node: Node, elapsed: number) =>
  settledAs(node, {
    status: "succeeded",
    details: { actionKey: `k-${node.name}`, entry, actionRan: true, elapsed },
  });
const hitOf = (node: Node, actionKey: string) =>
  settledAs(node, { status: "succeeded", details: { actionKey, entry, actionRan: false } });
const failed = (node: Node, message: string, elapsed: number, cause?: JsonValue) =>
  settledAs(node, {
    status: "failed",
    error: { name: "Error", message, ...(cause !== undefined && { cause }) },
    details: { actionKey: `k-${node.name}`, elapsed },
  });

/**
 * The `live` terminal on a `columns`×`rows` TTY whose writes go straight into a terminal emulator
 * and are recorded, with links only if `hyperlinks`, whatever terminal runs the tests, its store
 * over memory `files`, events stamped with the clock's `now`. Each node that started has a log
 * file, as the log files give one.
 */
function liveRun(
  opts: {
    columns?: number;
    rows?: number;
    files?: Record<string, string>;
    stdout?: Partial<WriteStreams["stdout"]>;
    hyperlinks?: boolean;
  } = {},
) {
  const { columns = 40, rows = 12 } = opts;
  let now = 0;
  const term = new xterm.Terminal({
    cols: columns,
    rows,
    scrollback: 1000,
    convertEol: true,
    allowProposedApi: true,
  });
  const writes: string[] = [];
  const write = (chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    term.write(chunk);
    return true;
  };
  const streams: WriteStreams = {
    stdout: { write, columns, rows, isTTY: true, ...opts.stdout },
    stderr: { write },
  };
  const logged = new Set<string>();
  // supports-hyperlinks reads this as the terminal is made.
  process.env.FORCE_HYPERLINK = opts.hyperlinks ? "1" : "0";
  const { listener } = createTerminal({
    style: "live",
    files: {
      logFile: (name) => (logged.has(name) ? `.dag/logs/${name}.log` : undefined),
      workflowFile: "ci.ts",
      failuresReportPath: ".dag/failures.md",
      logDir: ".dag/logs",
      summaryPath: ".dag/summary.md",
    },
    streams,
    clock: { epochMilliseconds: () => now },
    host: createRecordingHost().host,
  });
  delete process.env.FORCE_HYPERLINK;
  const store = createRunStore({
    fs: createMemoryFileSystem(opts.files),
    buildLogDir: "/build-logs",
    durationsFile: "/durations/ci.ts.json",
    listeners: [listener, { immediate: { start: ({ node }) => void logged.add(node.name) } }],
  });
  /** As the engine stamps its events, from the clock. */
  const emit = (events: ExecutionEvent[]) => {
    for (const event of events) store.onEvent({ ...event, occurredAt: now });
  };
  const tick = () => mock.timers.tick(LIVE_FRAME_MS);
  return {
    store,
    streams,
    writes,
    emit,
    tick,
    setNow: (ms: number) => void (now = ms),
    /** The run caught up to `ms`, after `events`, and the frame drawn then. */
    at: async (pass: Pass, ms: number, events: ExecutionEvent[] = []) => {
      now = ms;
      emit(events);
      await store.report(pass);
      tick();
    },
    /** What the user types, which the terminal echoes at the cursor. */
    echo: (text: string) => term.write(text),
    /** The window resized once the terminal has drawn what it was sent. */
    resize: async (columns: number, rows: number) => {
      await new Promise<void>((drawn) => term.write("", drawn));
      term.resize(columns, rows);
      Object.assign(streams.stdout, { columns, rows });
    },
    /** The lines scrolled off the top, and the window's, its trailing blank rows dropped. */
    screen: async () => {
      await new Promise<void>((done) => term.write("", done));
      const buffer = term.buffer.active;
      const lines = Array.from({ length: buffer.length }, (_, i) => {
        const line = buffer.getLine(i);
        assert.ok(line, `line ${i}`);
        return line.translateToString(true);
      });
      const window = lines.slice(buffer.baseY);
      while (window.at(-1) === "") window.pop();
      return { scrollback: lines.slice(0, buffer.baseY), window };
    },
    /** The rows the last frame drew under the scrollback, escapes and all. */
    footer: () => /\x1b\[\?7l([^]*)\r\x1b\[\?7h/.exec(writes.at(-1) ?? "")?.[1]?.split("\n") ?? [],
  };
}

const all = ({ scrollback, window }: { scrollback: string[]; window: string[] }) => [
  ...scrollback,
  ...window,
];
const passOf = (title: string, nodes: Node[]): Pass => ({
  banner: { title, lines: [] },
  title: "ci.ts",
  nodes,
});

describe("live footer", () => {
  test("truncation counts terminal columns and stops measuring at the width", () => {
    assert.deepEqual(
      {
        fits: truncate("typecheck", 9),
        ascii: truncate("typecheck 4.0s", 10),
        wide: truncate("日本語のログ", 7),
        long: truncate("é".repeat(1_000_000), 5),
      },
      { fits: "typecheck", ascii: "typecheck…", wide: "日本語…", long: "éééé…" },
    );
  });
});

describe("live terminal", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setInterval"] }));
  afterEach(() => mock.timers.reset());

  test("the footer never shows a warning command as a node's latest line", async () => {
    const run = liveRun();
    const lint = nodeNamed("lint");
    const pass = passOf("ci.ts · 1 node", [lint]);
    run.store.begin(pass);
    await run.at(pass, 0, started(lint));
    await run.at(pass, 600, [
      printed(lint, `checking src\n${warningCommand("lint", "deprecated rule")}`),
    ]);
    const printing = await run.screen();
    await run.at(pass, 700, [printed(lint, "\n")]);
    const ended = await run.screen();
    assert.deepEqual(
      { printing: printing.window, ended: ended.window },
      {
        printing: [
          "ci.ts · 1 node · logs .dag/logs/",
          "⠦ lint 0.6s  checking src",
          "[0/1] 1 running · ctrl-c cancels",
        ],
        ended: [
          "ci.ts · 1 node · logs .dag/logs/",
          "⠧ lint 0.7s  checking src",
          "[0/1] 1 running · ctrl-c cancels",
        ],
      },
    );
  });

  test("during a build: the footer under the scrollback, a node settling above it", async () => {
    const run = liveRun();
    const lint = nodeNamed("lint");
    const typecheck = nodeNamed("typecheck");
    const testNode = nodeNamed("test");
    const docs = nodeNamed("docs", { deps: ["lint"] });
    const pass = passOf("ci.ts · 4 nodes", [lint, typecheck, testNode, docs]);
    run.store.begin(pass);
    // Two at a time: test waits for a slot.
    await run.at(pass, 0, [
      ...started(lint),
      ...started(typecheck),
      dispatched(testNode),
      pending(testNode),
    ]);
    await run.at(pass, 600, [
      printed(lint, "checking src\nsrc/feed.ts ok\n"),
      printed(typecheck, "[===   ] 30%\r[====== ] 60%\r"),
    ]);
    const running = await run.screen();
    await run.at(pass, 1200, [built(lint, 1200), ...started(docs)]);
    const settled = await run.screen();
    const title = ["ci.ts · 4 nodes · logs .dag/logs/"];
    assert.deepEqual(
      { running, settled },
      {
        running: {
          scrollback: [],
          window: [
            ...title,
            "⠦ lint      0.6s  src/feed.ts ok",
            "⠦ typecheck 0.6s  [====== ] 60%",
            "· test      queued",
            "· docs      waits on lint",
            "[0/4] 2 running · 1 queued · ctrl-c ca…",
          ],
        },
        settled: {
          scrollback: [],
          window: [
            ...title,
            "✔︎ lint      1.2s · 2 lines",
            "⠹ typecheck 1.2s  [====== ] 60%",
            "⠹ docs      0.0s",
            "· test      queued",
            "[1/4] 2 running · 1 queued · ctrl-c ca…",
          ],
        },
      },
    );
  });

  test("scrollback during a build keeps each line once and no footer row", async () => {
    const run = liveRun({ rows: 8 });
    const bundle = nodeNamed("bundle");
    const packages = Array.from({ length: 8 }, (_, i) => nodeNamed(`pkg${i + 1}`));
    const pass = passOf("ci.ts · 9 nodes", [bundle, ...packages]);
    run.store.begin(pass);
    await run.at(pass, 0, [bundle, ...packages].flatMap(started));
    run.emit([printed(bundle, "bundling\n")]);
    for (const [i, node] of packages.entries()) {
      run.emit([printed(node, `ok ${i + 1}\n`)]);
      if (i % 4 === 0) run.streams.stdout.write(`a stray write ${i + 1}\n`);
      const elapsed = 600 + i * 100;
      await run.at(pass, elapsed, [
        node.name === "pkg3"
          ? failed(node, "pkg3 exited 1", elapsed, {
              argv: ["pkg3"],
              cwd: ".",
              ended: "exited",
              code: 1,
            })
          : built(node, elapsed),
      ]);
    }
    await run.at(pass, 1500);
    const midBuild = await run.screen();
    run.emit([built(bundle, 1500)]);
    await run.store.close();
    const scrollback = [
      "ci.ts · 9 nodes · logs .dag/logs/",
      "a stray write 1",
      "✔︎ pkg1   0.6s · 1 line",
      "✔︎ pkg2   0.7s · 1 line",
      "✖︎ pkg3  exit 1 · 0.8s · 1 line",
      "│ ok 3",
      "├ log    .dag/logs/pkg3.log",
      "├ cmd    pkg3   (cwd .)",
      "└ rerun  npx --no dag run ci.ts --only p",
      "kg3",
    ];
    const settledPackages = [
      "✔︎ pkg4   0.9s · 1 line",
      "a stray write 5",
      "✔︎ pkg5   1.0s · 1 line",
      "✔︎ pkg6   1.1s · 1 line",
      "✔︎ pkg7   1.2s · 1 line",
      "✔︎ pkg8   1.3s · 1 line",
    ];
    assert.deepEqual(
      { midBuild, final: all(await run.screen()) },
      {
        midBuild: {
          scrollback,
          window: [
            ...settledPackages,
            "⠴ bundle 1.5s  bundling",
            "[8/9 ✖︎1] 1 running · ctrl-c cancels",
          ],
        },
        final: [
          ...scrollback,
          ...settledPackages,
          "✔︎ bundle 1.5s · 1 line",
          "",
          "✖︎ pkg3 failed · ci.ts · wall 1.5s",
          "built 8 · cached 0 · failed 1 · skipped ",
          "0",
          "",
          "✖︎ pkg3   exit 1 · 0.8s · 1 line   .dag/l",
          "ogs/pkg3.log",
          "",
          "rerun    npx --no dag run ci.ts --only p",
          "kg3",
          "report   .dag/failures.md   (hand this t",
          "o an agent)",
          "logs     .dag/logs/",
        ],
      },
    );
  });

  test("a window made narrower, then wider, during a build leaves no row behind", async () => {
    const run = liveRun({ columns: 60 });
    const lint = nodeNamed("lint");
    const typecheck = nodeNamed("typecheck");
    const pass = passOf("ci.ts · 2 nodes", [lint, typecheck]);
    run.store.begin(pass);
    await run.at(pass, 0, [...started(lint), ...started(typecheck)]);
    run.emit([
      printed(lint, "linting src/settings/notifications/email-digest.ts\n"),
      printed(typecheck, "checking 412 files\n"),
    ]);
    await run.at(pass, 600);
    await run.resize(30, 12);
    await run.at(pass, 700);
    const narrowed = await run.screen();
    await run.resize(50, 12);
    await run.at(pass, 800);
    const widened = await run.screen();
    run.emit([built(lint, 800), built(typecheck, 800)]);
    await run.store.close();
    assert.deepEqual(
      { narrowed: narrowed.window, widened: widened.window, final: (await run.screen()).window },
      {
        narrowed: [
          "ci.ts · 2 nodes · logs .dag/lo",
          "gs/",
          "⠧ lint      0.7s  linting sr…",
          "⠧ typecheck 0.7s  checking 4…",
          "[0/2] 2 running · ctrl-c can…",
        ],
        widened: [
          "ci.ts · 2 nodes · logs .dag/logs/",
          "⠇ lint      0.8s  linting src/settings/notificat…",
          "⠇ typecheck 0.8s  checking 412 files",
          "[0/2] 2 running · ctrl-c cancels",
        ],
        final: [
          "ci.ts · 2 nodes · logs .dag/logs/",
          "✔︎ lint      0.8s · 1 line",
          "✔︎ typecheck 0.8s · 1 line",
          "",
          "✔︎ all 2 nodes succeeded · ci.ts · wall 0.8s",
          "built 2 · cached 0 · failed 0 · skipped 0",
          "",
          "logs     .dag/logs/",
        ],
      },
    );
  });

  test("a run: its output before it begins, the footer under the scrollback, cache hits gathered", async () => {
    const run = liveRun({
      files: {
        "/durations/ci.ts.json": JSON.stringify({
          durations: {
            lint: 1000,
            "test:a": 2000,
            "integration:packages-dagworkflows-e2e": 64_000,
          },
        }),
        "/build-logs/kb.log": "\x1b[1mbundled\x1b[22m 3 files\n",
      },
    });
    const lint = nodeNamed("lint");
    const e2e = nodeNamed("integration:packages-dagworkflows-e2e");
    const testA = nodeNamed("test:a", { concurrencyGroup: "test" });
    const testB = nodeNamed("test:b", { concurrencyGroup: "test" });
    const build = nodeNamed("build");
    const docs = nodeNamed("docs", { deps: ["build"] });
    const requireAll = nodeNamed("require-all", { deps: ["lint"] });
    const deploy = nodeNamed("deploy", { deps: ["require-all"] });
    const fmt = nodeNamed("fmt");
    const pass = passOf("ci.ts · 9 nodes", [
      lint,
      e2e,
      testA,
      testB,
      build,
      docs,
      requireAll,
      deploy,
      fmt,
    ]);
    // The implementation prints as it builds the graph, before the run begins.
    run.streams.stdout.write("resolving workspace\n");
    const beforeBegin = run.writes.join("");
    run.store.begin(pass);
    // The run begins before its first event, as the runner's awaits make it.
    await new Promise(setImmediate);
    run.emit([
      ...started(lint),
      ...started(e2e),
      ...started(testA),
      dispatched(build),
      printed(lint, "checking src\n"),
      printed(e2e, "x".repeat(100)),
      printed(testA, "ok 1 - parses\tthe feed\n"),
    ]);
    await new Promise((written) => run.streams.stderr.write("a stray stderr write\n", written));
    run.streams.stdout.write("::debug::walking src\n");
    // Only a cache hit has settled, and the footer already has each node's last run.
    await run.at(pass, 600, [dispatched(fmt), hitOf(fmt, "kf"), dispatched(testB), pending(testB)]);
    const midRun = all(await run.screen());
    run.echo("^C");
    await run.at(pass, 900, [
      printed(lint, "src/a.ts:1:1 error no-console\n"),
      failed(lint, "eslint . exited 1", 900, {
        argv: ["eslint", "."],
        cwd: ".",
        ended: "exited",
        code: 1,
      }),
      ...started(requireAll),
      failed(requireAll, "failed: lint", 1),
      settledAs(deploy, { status: "dep-failed", dep: "require-all", rootCauses: ["require-all"] }),
    ]);
    await run.at(pass, 1500, [
      built(testA, 1500),
      start(testB),
      built(testB, 1),
      built(e2e, 1500),
      hitOf(build, "kb"),
      dispatched(docs),
      hitOf(docs, "kd"),
    ]);
    await run.store.close();
    assert.deepEqual(
      { beforeBegin, midRun, final: all(await run.screen()) },
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
          "· test:b                   queued",
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
          "✖︎ require-all  0.0s",
          "│ failed: lint",
          "├ log    .dag/logs/require-all.log",
          "├ deps   lint also failed",
          "└ rerun  npx --no dag run ci.ts --only r",
          "equire-all",
          "⏭︎ deploy                   skipped (beca",
          "use require-all failed)",
          "✔︎ test:a                   1.5s · 1 line",
          "✔︎ test:b                   0.0s",
          "✔︎ integration:packages-dagworkflows-e2e ",
          "1.5s · 1 line",
          "✔︎ cached: build, docs",
          "",
          "✖︎ lint, require-all failed · ci.ts · wal",
          "l 1.5s",
          "built 3 · cached 3 · failed 2 · skipped ",
          "1",
          "",
          "✖︎ lint          exit 1 · 0.9s · 2 lines ",
          "  .dag/logs/lint.log",
          "✖︎ require-all   0.0s   .dag/logs/require",
          "-all.log",
          "  ⏭︎ deploy skipped because of it",
          "",
          "rerun    npx --no dag run ci.ts --only l",
          "int,require-all",
          "report   .dag/failures.md   (hand this t",
          "o an agent)",
          "logs     .dag/logs/",
        ],
      },
    );
  });

  test("a cancel, then the post pass, and the terminal as it was left", async () => {
    const run = liveRun();
    const fast = nodeNamed("fast");
    const slow = nodeNamed("slow", { deps: ["fast"] });
    // The release waits for slow, which uses what fast set up.
    const release = nodeNamed("release", { deps: ["fast", "slow"] });
    const pass = passOf("ci.ts · 3 nodes", [fast, slow, release]);
    run.store.begin(pass);
    await run.at(pass, 0, [...started(fast), printed(fast, "fast ok\n"), built(fast, 1)]);
    run.emit([...started(slow), printed(slow, "compiling")]);
    await run.at(pass, 600);
    run.setNow(31_000);
    run.store.cancel();
    run.emit([printed(slow, "\nkilled by SIGINT\n")]);
    run.tick();
    const cancelling = all(await run.screen());
    run.emit([
      settledAs(slow, { status: "cancelled", details: { actionKey: "k-slow", elapsed: 31_000 } }),
      settledAs(release, { status: "cancelled" }),
    ]);
    await run.store.report(pass);
    // Owed, since fast started.
    const post = passOf("post · 1 of 1 post steps owed", [release]);
    run.store.begin(post);
    run.emit([...started(release), printed(release, "release ok\n"), built(release, 1)]);
    await run.store.report(post);
    await run.store.close();
    // No redraw once the run has ended, and the terminal's writes are its own again.
    run.tick();
    run.streams.stderr.write("after the run\n");
    assert.deepEqual(
      { cancelling, final: all(await run.screen()) },
      {
        cancelling: [
          "ci.ts · 3 nodes · logs .dag/logs/",
          "✔︎ fast    0.0s · 1 line",
          "⠋ slow    31.0s  killed by SIGINT",
          "· release waits on slow",
          "[1/3] cancelling: waiting for 1 runnin…",
        ],
        final: [
          "ci.ts · 3 nodes · logs .dag/logs/",
          "✔︎ fast    0.0s · 1 line",
          "◼︎ slow    cancelled after 31.0s",
          "post · 1 of 1 post steps owed",
          "✔︎ release 0.0s · 1 line",
          "",
          "◼︎ cancelled, 1 node not run · ci.ts · wa",
          "ll 31.0s",
          "built 2 · cached 0 · failed 0 · skipped ",
          "0 · cancelled 1",
          "",
          "logs     .dag/logs/",
          "after the run",
        ],
      },
    );
  });

  test("a forced exit: the line naming the nodes it stopped under the scrollback, no footer left, and the terminal's writes its own again", async () => {
    const run = liveRun({ columns: 80 });
    const lint = nodeNamed("lint");
    const build = nodeNamed("build");
    const pass = passOf("ci.ts · 2 nodes", [lint, build]);
    run.store.begin(pass);
    await run.at(pass, 0, [...started(lint), ...started(build)]);
    await run.at(pass, 600);
    const running = all(await run.screen());
    run.store.interrupt();
    run.tick();
    run.streams.stderr.write("after\n");
    assert.deepEqual(
      { running, forced: all(await run.screen()) },
      {
        running: [
          "ci.ts · 2 nodes · logs .dag/logs/",
          "⠦ lint  0.6s",
          "⠦ build 0.6s",
          "[0/2] 2 running · ctrl-c cancels",
        ],
        forced: [
          "ci.ts · 2 nodes · logs .dag/logs/",
          "",
          "◼︎ forced exit while lint, build ran · report .dag/failures.md",
          "after",
        ],
      },
    );
  });

  test("a crowd, in color with links, then a cancel", async () => {
    const run = liveRun({ hyperlinks: true, stdout: { hasColors: () => true } });
    const [a1, a2, a3, a4, a5, a6] = [
      nodeNamed("a1"),
      nodeNamed("a2"),
      nodeNamed("a3"),
      nodeNamed("a4"),
      nodeNamed("a5"),
      nodeNamed("a6"),
    ];
    const [b, c] = [nodeNamed("b"), nodeNamed("c")];
    const w = nodeNamed("w", { deps: ["b", "c", "a6"] });
    const g = nodeNamed("g", { deps: ["a1"] });
    const io = { deps: ["a6"], concurrencyGroup: "io" };
    const [x, y] = [nodeNamed("x", io), nodeNamed("y", io)];
    // The last is skipped because the one before it was.
    const skipped = [1, 2, 3, 4, 5, 6].map((i) =>
      nodeNamed(`s${i}`, { deps: [i < 6 ? "a1" : "s5"] }),
    );
    const pass = passOf("ci.ts · 18 nodes", [a1, a2, a3, a4, a5, a6, w, b, c, g, x, y, ...skipped]);
    const screenAt = async (ms: number) => {
      run.setNow(ms);
      run.tick();
      return all(await run.screen());
    };
    run.store.begin(pass);
    await new Promise(setImmediate);
    // A second passes as the graph is built: no footer before the first node is dispatched.
    const beforeDispatch = await screenAt(1000);
    // Started last to first, so the earliest in flight is the last in the graph.
    for (const [i, node] of [a6, a5, a4, a3, a2, a1].entries()) {
      run.setNow(1000 + i * 10);
      run.emit(started(node));
      await run.store.report(pass);
    }
    run.emit([
      printed(a6, "ok\tparses­ the feed\n"),
      printed(a5, "\x1b[32m50%\x1b[39m"),
      printed(a4, "built\n\n::debug::walking src"),
      printed(a3, "linked\n  "),
    ]);
    const beforeFirstDraw = await screenAt(1300);
    await screenAt(1600);
    const crowded = run.footer();
    run.setNow(1900);
    run.emit([
      printed(a1, "checking src\nsrc/a.ts:1:1 error no-console\n"),
      failed(
        a1,
        'run "a1": output "report" (lint.xml) was not written. Write it at out.report before the action returns.',
        850,
        { argv: ["eslint", "."], cwd: ".", ended: "exited", code: 0 },
      ),
      ...started(g),
      failed(g, "failed: a1", 1),
      ...skipped.map((node) =>
        settledAs(node, { status: "dep-failed", dep: node.deps.join(), rootCauses: ["a1"] }),
      ),
      ...[a2, a3, a4, a5].map((node) => built(node, 860)),
      ...started(b),
    ]);
    await run.store.report(pass);
    // Stray writes that end no line: each keeps a line of its own.
    run.streams.stdout.write(Buffer.from("linking"));
    const waiting = await screenAt(2200);
    run.streams.stdout.write("building");
    run.setNow(2300);
    run.emit([built(a6, 1300), ...started(x), dispatched(y), pending(y)]);
    await run.store.report(pass);
    run.emit([printed(x, "uploading")]);
    await screenAt(2400);
    const queued = run.footer();
    run.store.cancel();
    run.setNow(2500);
    run.emit([
      built(b, 600),
      dispatched(c),
      hitOf(c, "kc"),
      settledAs(x, { status: "cancelled", details: { actionKey: "kx", elapsed: 200 } }),
      // y looked its key up before the scheduler held it back, yet never ran: no line.
      settledAs(y, { status: "cancelled", details: { actionKey: "ky" } }),
      settledAs(w, { status: "cancelled" }),
    ]);
    await run.store.report(pass);
    // As the runner begins a post pass that owes nothing.
    run.store.begin({ title: "ci.ts · post", nodes: [] });
    await run.store.close();
    // What the frames printed above the footer, escapes and all.
    const printedAbove = run.writes
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
      { beforeDispatch, beforeFirstDraw, crowded, waiting, queued, printedAbove },
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
          "✖︎ g  0.0s",
          "│ failed: a1",
          "├ log    .dag/logs/g.log",
          "├ deps   a1 also failed",
          "└ rerun  npx --no dag run ci.ts --only g",
          ...skipped.map((node) => `⏭︎ ${node.name} skipped (because a1 failed)`),
          "✔︎ a2 0.9s",
          "✔︎ a3 0.9s · 1 line",
          "✔︎ a4 0.9s · 2 lines",
          "✔︎ a5 0.9s · 1 line",
          "linking",
          "⠹ a6 1.2s  ok parses the feed",
          "⠹ b  0.3s",
          "· c  queued",
          "· w  waits on b, c +1",
          "[12/18 ✖︎2] 2 running · 1 queued · ctrl…",
        ],
        queued: [
          `${cyan("⠼")} b 0.5s`,
          `${cyan("⠼")} x 0.1s  ${dim("uploading")}`,
          dim("· c queued"),
          dim("· y queued"),
          "[13/18 ✖︎2] 2 running · 2 queued · ctrl…",
        ],
        printedAbove: [
          `${bold("ci.ts · 18 nodes")} · logs ${link(".dag/logs")}/`,
          `${red("✖︎")} ${bold("a1")}  ${dim("0.8s · 2 lines")}`,
          `${dim("│")} checking src`,
          `${dim("│")} src/a.ts:1:1 error no-console`,
          `${dim("│")} ${red('run "a1": output "report" (lint.xml) was not written. Write it at out.report before the action returns.')}`,
          `${dim("├ log    ")}${link(".dag/logs/a1.log")}`,
          `${dim("├ cmd    ")}eslint .   ${dim("(cwd .)")}`,
          `${dim("└ rerun  ")}npx --no dag run ci.ts --only a1`,
          `${red("✖︎")} ${bold("g")}  ${dim("0.0s")}`,
          `${dim("│")} ${red("failed: a1")}`,
          `${dim("├ log    ")}${link(".dag/logs/g.log")}`,
          `${dim("├ deps   ")}a1 also failed`,
          `${dim("└ rerun  ")}npx --no dag run ci.ts --only g`,
          ...skipped.map(
            (node) => `${yellow("⏭︎")} ${node.name} ${dim("skipped (because a1 failed)")}`,
          ),
          `${green("✔︎")} a2 ${dim("0.9s")}`,
          `${green("✔︎")} a3 ${dim("0.9s · 1 line")}`,
          `${green("✔︎")} a4 ${dim("0.9s · 2 lines")}`,
          `${green("✔︎")} a5 ${dim("0.9s · 1 line")}`,
          "linking",
          "building",
          `${green("✔︎")} a6 ${dim("1.3s · 1 line")}`,
          `${green("✔︎")} b  ${dim("0.6s")}`,
          `${green("✔︎")} ${dim("cached:")} c`,
          `${gray("◼︎")} x  ${dim("cancelled after 0.2s")}`,
          "",
          `${bold("✖︎ a1, g failed")} · ci.ts · wall 1.5s`,
          dim("built 6 · cached 1 · failed 2 · skipped 6 · cancelled 3"),
          "",
          `${red("✖︎")} a1   0.8s · 2 lines   ${link(".dag/logs/a1.log")}`,
          `  ${yellow("⏭︎")} s1, s2, s3, s4, s5 +1 skipped because of it`,
          `${red("✖︎")} g    0.0s   ${link(".dag/logs/g.log")}`,
          "",
          `${dim("rerun    ")}npx --no dag run ci.ts --only a1,g`,
          `${dim("report   ")}${link(".dag/failures.md")}${dim("   (hand this to an agent)")}`,
          `${dim("logs     ")}${link(".dag/logs")}/`,
          "",
        ],
      },
    );
  });

  test("a frame's bytes, and a stopped post step's row afresh in the post pass", async () => {
    const run = liveRun();
    const save = nodeNamed("save");
    const main = { title: "ci.ts", nodes: [save] };
    const post = { title: "ci.ts · post", nodes: [save] };
    run.store.begin(main);
    await new Promise(setImmediate);
    run.emit([...started(save), printed(save, "saving\n")]);
    run.store.cancel();
    run.emit([printed(save, "killed by SIGINT\n")]);
    run.setNow(600);
    run.tick();
    const stopping = run.writes.at(-1);
    run.emit([
      settledAs(save, { status: "cancelled", details: { actionKey: "ks", elapsed: 600 } }),
    ]);
    await run.store.report(main);
    run.store.begin(post);
    await new Promise(setImmediate);
    run.emit(started(save));
    run.setNow(1200);
    run.tick();
    const again = all(await run.screen());
    await run.store.close();
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
          "ci.ts · logs .dag/logs/",
          "◼︎ save cancelled after 0.6s",
          "ci.ts · post",
          "⠹ save 0.6s",
          "[0/1] cancelling: waiting for 1 runnin…",
        ],
      },
    );
  });

  test("the footer before a node's action starts: checking cache, or starting for a node with no cache", async () => {
    const run = liveRun();
    const build = nodeNamed("build");
    const deploy = nodeNamed("deploy", { cacheable: false });
    run.store.begin({ title: "ci.ts", nodes: [build, deploy] });
    await new Promise(setImmediate);
    run.emit([dispatched(build), dispatched(deploy)]);
    run.setNow(600);
    run.tick();
    const footer = run.footer();
    await run.store.close();
    assert.deepEqual(footer, [
      "⠦ build  0.6s  checking cache",
      "⠦ deploy 0.6s  starting",
      "[0/2] 2 running · ctrl-c cancels",
    ]);
  });

  test("the footer in other windows", async () => {
    const run = liveRun();
    const nodes = Array.from({ length: 9 }, (_, i) => nodeNamed(`node${i + 1}`));
    run.store.begin({ title: "ci.ts", nodes });
    await new Promise(setImmediate);
    run.emit(nodes.flatMap(started));
    run.emit([
      printed(
        nodeNamed("node1"),
        "src/settings/notifications/email-digest-preferences.test.tsx passed\n",
      ),
    ]);
    run.setNow(600);
    const sizedAs = (columns?: number, rows?: number) => {
      Object.assign(run.streams.stdout, { columns, rows });
      run.tick();
      return run.footer();
    };
    // Three columns to spare are too few for a line; a size unknown is taken as 80×24.
    const footers = { narrow: sizedAs(17, 12), unsized: sizedAs(), wide: sizedAs(120, 50) };
    await run.store.close();
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
