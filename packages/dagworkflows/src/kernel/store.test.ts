import {
  execute,
  file,
  Graph,
  settled as settledDep,
  type ExecEvent,
  type JsonValue,
  type MemoryDagFs,
  type Node,
  type Result,
} from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addCommand } from "../commands.ts";
import type { Ports } from "../ports.ts";
import { createTestPorts, steppingClock } from "../ports/memory.ts";
import {
  errorMessage,
  failureMessage,
  formatDuration,
  reportHeadline,
  warningMessages,
} from "./format.ts";
import type { NodeReport } from "./report.ts";
import { completedLines, initialNodeState, nodeReducer, type NodeState } from "./run-slice.ts";
import * as selectors from "./selectors.ts";
import { createRunStore, type RunListener } from "./store.ts";

const node = (name: string, deps: string[] = []): Node => ({ name, kind: name, deps });
const parsed = async (text: Promise<string>): Promise<unknown> => JSON.parse(await text);
const [a, b, c, d, f, save] = [
  node("a"),
  node("b"),
  node("c"),
  node("d", ["b"]),
  node("f", ["a"]),
  node("save"),
];
type Settled<R = Result> = R extends unknown ? Omit<R, "name"> : never;
const resultOf = (n: Node, result: Settled): Result => ({ name: n.name, ...result });
const resultEvent = (result: Result): ExecEvent => ({
  type: "result",
  node: result.name,
  result,
  occurredAt: 0,
});
const settled = (n: Node, result: Settled): ExecEvent => resultEvent(resultOf(n, result));
const builtResult = (n: Node, key: string, elapsed = 1000): Result =>
  resultOf(n, {
    actionKey: key,
    status: "done",
    outputs: { out: key },
    contentHash: "h",
    outputHashes: {},
    elapsed,
  });
const failedResult = (n: Node, key: string, message: string, cause?: JsonValue): Result =>
  resultOf(n, {
    actionKey: key,
    status: "failed",
    error: { name: "Error", message, ...(cause !== undefined && { cause }) },
    elapsed: 1000,
  });
const built = (n: Node, key: string, elapsed?: number): ExecEvent =>
  resultEvent(builtResult(n, key, elapsed));
const failed = (n: Node, key: string, message: string, cause?: JsonValue): ExecEvent =>
  resultEvent(failedResult(n, key, message, cause));
const started = (n: Node): ExecEvent[] => [
  { type: "dispatch", node: n.name, occurredAt: 0 },
  { type: "start", node: n.name, occurredAt: 0 },
];
const printed = (n: Node, chunk: string): ExecEvent => ({
  type: "output",
  node: n.name,
  chunk,
  occurredAt: 0,
});
const command = { argv: ["make", "b"], cwd: ".", ended: "exited", code: 2 };
const BUILD_LOG_DIR = "/build-logs";
const DURATIONS_FILE = "/durations/ci.ts.json";
/** The last run's durations, and earlier builds' logs, which a hit shows and a failure never touches. */
const files = {
  [DURATIONS_FILE]: JSON.stringify({ durations: { a: 500, f: 1500 } }),
  [`${BUILD_LOG_DIR}/ka.log`]: "a from an earlier build\n",
  [`${BUILD_LOG_DIR}/kb.log`]: "b from an earlier build\n",
  [`${BUILD_LOG_DIR}/kc.log`]: "c from an earlier run\n",
  [`${BUILD_LOG_DIR}/kf.log`]: "f from an earlier build\n",
};
const buildLogsOf = (fs: MemoryDagFs) =>
  Object.fromEntries(
    [...fs.files]
      .filter(([path]) => path.startsWith(`${BUILD_LOG_DIR}/`))
      .map(([path, file]) => [path, file.data]),
  );

/** A store, and its events as an engine stamps them: a second apart, what a node prints aside. */
function storeOf(listeners: RunListener[]) {
  const { fs } = createTestPorts({ files });
  const store = createRunStore({
    fs,
    buildLogDir: BUILD_LOG_DIR,
    durationsFile: DURATIONS_FILE,
    listeners,
  });
  const clock = steppingClock();
  return {
    fs,
    store,
    events: (...events: ExecEvent[]) =>
      events.forEach((event) =>
        store.onEvent(event.type === "output" ? event : { ...event, occurredAt: clock.now() }),
      ),
  };
}

/**
 * What one listener hears of a run, then of a post pass begun while the run's settles are still
 * being read, re-running a node the run cancelled, its step running while they are told.
 */
async function transcript() {
  const main = { title: "main", nodes: [a, b, c, d, f, save] };
  const post = { title: "post", nodes: [save] };
  const heard: unknown[][] = [];
  const { store, events } = storeOf([
    {
      begin: (pass, _run, first) => void heard.push(["begin", pass.title, first]),
      start: (nodeState, run) =>
        void heard.push([
          "start",
          nodeState.node.name,
          nodeState.status,
          run.lastRunDurations?.[nodeState.node.name],
        ]),
      settle: (nodeState, _run, log) =>
        void heard.push([
          "settle",
          nodeState.node.name,
          nodeState.status,
          log,
          (nodeState.status === "failed" && selectors.commandOf(nodeState.result.error)) ||
            "no command",
        ]),
      finish: (pass, nodes) =>
        void heard.push([
          "finish",
          pass.title,
          nodes.map(
            ({ node, result, duration }) => `${node.name} ${result.status} in ${duration}ms`,
          ),
        ]),
      immediate: {
        start: (nodeState) => void heard.push(["immediate.start", nodeState.node.name]),
        output: (nodeState, lines) =>
          void heard.push(["immediate.output", nodeState.node.name, lines]),
      },
    },
  ]);
  store.begin(main);
  events(...started(a), printed(a, "a out\npa"), printed(a, "rt"));
  events(...started(b), printed(b, "::debug::walking\nb out\n"));
  events(
    built(a, "ka"),
    ...started(f),
    failed(b, "kb", "make b exited 2", command),
    { type: "dispatch", node: "c", occurredAt: 0 },
    settled(c, {
      actionKey: "kc",
      status: "cached",
      outputs: { out: "kc" },
      contentHash: "h",
      outputHashes: {},
    }),
    settled(d, { actionKey: "", status: "dep-failed", dep: "b" }),
    failed(f, "kf", "upload refused", { name: "Error", message: "ECONNREFUSED" }),
    ...started(save),
    settled(save, { actionKey: "ks", status: "cancelled" }),
  );
  store.begin(post);
  events(...started(save));
  await new Promise(setImmediate);
  events(printed(save, "saved\n"));
  events(built(save, "kp"));
  await store.finish(post, await store.report(post));
  return heard;
}

const skippedByB = resultOf(d, {
  actionKey: "",
  status: "dep-failed",
  dep: "b",
  rootCauses: ["b"],
});
const cancelledRunning = resultOf(c, { actionKey: "kc", status: "cancelled", elapsed: 1000 });

/**
 * A run of a built node, whose action took 600 ms of the second from its start to its result, a
 * failed one, one it skipped and one a cancel stopped, reported while another still runs.
 */
async function failedRun() {
  const pass = { title: "main", nodes: [a, b, c, d, save] };
  const { fs, store, events } = storeOf([]);
  store.begin(pass);
  events(
    ...started(a),
    printed(a, "a out\npart"),
    built(a, "ka", 600),
    ...started(b),
    printed(b, "::debug::walking\nb out\n"),
    failed(b, "kb", "make b exited 2", command),
    resultEvent(skippedByB),
    ...started(c),
    printed(c, "c out\n"),
    resultEvent(cancelledRunning),
    ...started(save),
  );
  return { fs, store, pass, reports: await store.report(pass) };
}

describe("run store", () => {
  test("what a listener hears, then of a post pass begun while the run's settles are read", async () => {
    assert.deepEqual(await transcript(), [
      ["immediate.start", "a"],
      ["immediate.output", "a", ["a out"]],
      ["immediate.start", "b"],
      ["immediate.output", "b", ["b out"]],
      ["immediate.output", "a", ["part"]],
      ["immediate.start", "f"],
      ["immediate.start", "save"],
      ["immediate.start", "save"],
      ["begin", "main", true],
      // The last run is read as the pass begins.
      ["start", "a", "running", 500],
      ["start", "b", "running", undefined],
      ["settle", "a", "done", ["a out", "part"], "no command"],
      ["start", "f", "running", 1500],
      ["settle", "b", "failed", ["b out"], command],
      ["settle", "c", "cached", ["c from an earlier run"], "no command"],
      ["settle", "d", "dep-failed", [], "no command"],
      ["settle", "f", "failed", [], "no command"],
      ["start", "save", "running", undefined],
      ["settle", "save", "cancelled", [], "no command"],
      ["begin", "post", false],
      ["start", "save", "running", undefined],
      ["immediate.output", "save", ["saved"]],
      ["settle", "save", "done", ["saved"], "no command"],
      ["finish", "post", ["save done in 1000ms"]],
    ]);
  });

  test("a cache hit's report runs from its dispatch to its result and carries its last run", async () => {
    const pass = { title: "main", nodes: [a] };
    const { store, events } = storeOf([]);
    store.begin(pass);
    events(
      { type: "dispatch", node: "a", occurredAt: 0 },
      settled(a, {
        actionKey: "ka",
        status: "cached",
        outputs: { out: "ka" },
        contentHash: "h",
        outputHashes: {},
      }),
    );
    assert.deepEqual(await store.report(pass), [
      {
        node: a,
        result: resultOf(a, {
          actionKey: "ka",
          status: "cached",
          outputs: { out: "ka" },
          contentHash: "h",
          outputHashes: {},
        }),
        start: 0,
        duration: 1000,
        previous: 500,
      },
    ]);
  });

  test("a pass's report: the nodes that settled, with their results, from when each started for as long as the engine ran it", async () => {
    const { reports } = await failedRun();
    assert.deepEqual(reports, [
      { node: a, result: builtResult(a, "ka", 600), start: 1000, duration: 600, previous: 500 },
      {
        node: b,
        result: failedResult(b, "kb", "make b exited 2", command),
        start: 4000,
        duration: 1000,
      },
      { node: c, result: cancelledRunning, start: 8000, duration: 1000 },
      { node: d, result: skippedByB },
    ]);
  });

  test("writeDurations alone writes built and failed nodes over the last run as it was read", async () => {
    const { fs, store } = await failedRun();
    const afterReport = await parsed(fs.readText(DURATIONS_FILE));
    // As a restore that a cancel caught may leave it.
    await fs.writeText(DURATIONS_FILE, JSON.stringify({ durations: { a: 500 } }));
    await store.writeDurations();
    assert.deepEqual(
      { afterReport, written: await parsed(fs.readText(DURATIONS_FILE)) },
      {
        afterReport: { durations: { a: 500, f: 1500 } },
        written: { durations: { a: 600, b: 1000, f: 1500 } },
      },
    );
  });

  test("whether a node's action ran is the engine's word: one whose key needs a missing file, and one whose start the store heard but whose record then failed, have no start, duration or last run", async () => {
    const { ports, fs } = createTestPorts();
    const graph = new Graph<Ports>();
    const hash = addCommand(graph, {
      name: "hash",
      cmd: ["hash"],
      inputs: { "src/a.ts": file("src/a.ts") },
    });
    addCommand(graph, { name: "journal", cmd: ["journal"], deps: { hash: settledDep(hash) } });
    const store = createRunStore({ fs, durationsFile: DURATIONS_FILE, listeners: [] });
    const pass = { title: "main", nodes: graph.describe() };
    const [hashNode, journalNode] = pass.nodes;
    store.begin(pass);
    const [hashResult, journalResult] = await execute(
      graph,
      { ports, fs, cacheDir: "/cache", clock: steppingClock() },
      {
        // Heard before a record of the start that fails.
        onEvent: (event) => {
          store.onEvent(event);
          return event.type === "start" ? Promise.reject(new Error("disk full")) : undefined;
        },
      },
    );
    const reports = await store.report(pass);
    await store.writeDurations();
    assert.deepEqual(
      {
        hash: store.getState().nodes.get("hash"),
        reports,
        durations: await fs.exists(DURATIONS_FILE),
      },
      {
        hash: {
          node: hashNode,
          status: "failed",
          result: hashResult,
          endedAt: 1000,
          unfinishedLine: "",
          lastLine: "",
          printed: false,
          lineCount: 0,
          log: [],
        },
        reports: [
          { node: hashNode, result: hashResult },
          { node: journalNode, result: journalResult },
        ],
        durations: false,
      },
    );
  });

  test("a durations file it cannot read is no last run", async () => {
    const pass = { title: "main", nodes: [a] };
    const { fs, store, events } = storeOf([]);
    await fs.writeText(DURATIONS_FILE, "{ durations");
    store.begin(pass);
    events(...started(a), built(a, "ka"));
    await store.writeDurations();
    assert.deepEqual(
      {
        reports: await store.report(pass),
        file: await parsed(fs.readText(DURATIONS_FILE)),
      },
      {
        reports: [{ node: a, result: builtResult(a, "ka"), start: 1000, duration: 1000 }],
        file: { durations: { a: 1000 } },
      },
    );
  });

  test("the durations a run writes are never its last run's, though a read before found none", async () => {
    const pass = { title: "main", nodes: [a, b] };
    const { fs, store, events } = storeOf([]);
    fs.files.delete(DURATIONS_FILE);
    store.begin(pass);
    events(...started(a), built(a, "ka"));
    await store.writeDurations();
    events(...started(b), built(b, "kb"));
    await store.writeDurations();
    assert.deepEqual(
      {
        previous: (await store.report(pass)).map((report) => report.previous),
        file: await parsed(fs.readText(DURATIONS_FILE)),
      },
      { previous: [undefined, undefined], file: { durations: { a: 1000, b: 1000 } } },
    );
  });

  test("a node's log as its group prints it: a built node's kept under its key, any other's only in the run", async () => {
    const { fs, store } = await failedRun();
    assert.deepEqual(
      {
        a: await store.log("a"),
        b: await store.log("b"),
        c: await store.log("c"),
        d: await store.log("d"),
        buildLogs: buildLogsOf(fs),
      },
      {
        a: ["a out", "part"],
        b: ["b out", "── error ──", "make b exited 2"],
        c: ["c out"],
        d: ["dependency b failed"],
        buildLogs: {
          [`${BUILD_LOG_DIR}/ka.log`]: "a out\npart",
          [`${BUILD_LOG_DIR}/kb.log`]: "b from an earlier build\n",
          [`${BUILD_LOG_DIR}/kc.log`]: "c from an earlier run\n",
          [`${BUILD_LOG_DIR}/kf.log`]: "f from an earlier build\n",
        },
      },
    );
  });

  test("an empty or unwritable build log leaves none, and a failed write or read warns", async () => {
    const heard: Record<string, string[]> = {};
    const { fs, store, events } = storeOf([
      { settle: (nodeState, _run, log) => void (heard[nodeState.node.name] = log) },
    ]);
    const { writeText, readText } = fs;
    fs.writeText = async (path, text) => {
      if (text.includes("full")) throw new Error("ENOSPC: no space left on device, write");
      return writeText(path, text);
    };
    fs.readText = async (path) => {
      if (path.endsWith("/kc.log")) throw new Error(`EACCES: permission denied, open '${path}'`);
      return readText(path);
    };
    const pass = { title: "main", nodes: [a, b, c] };
    store.begin(pass);
    events(...started(a), built(a, "ka"));
    events(...started(b), printed(b, "b out\n"), printed(b, "disk full\n"), built(b, "kb"));
    events(
      { type: "dispatch", node: "c", occurredAt: 0 },
      settled(c, {
        actionKey: "kc",
        status: "cached",
        outputs: { out: "kc" },
        contentHash: "h",
        outputHashes: {},
      }),
    );
    await store.report(pass);
    const warning = (name: string, error: string) =>
      `::warning title=${name}::its build log in ${BUILD_LOG_DIR} could not be written or read: ${error}`;
    assert.deepEqual(
      { heard, buildLogs: buildLogsOf(fs) },
      {
        heard: {
          a: [],
          b: ["b out", "disk full", warning("b", "ENOSPC: no space left on device, write")],
          c: [warning("c", `EACCES: permission denied, open '${BUILD_LOG_DIR}/kc.log'`)],
        },
        buildLogs: {
          [`${BUILD_LOG_DIR}/kc.log`]: "c from an earlier run\n",
          [`${BUILD_LOG_DIR}/kf.log`]: "f from an earlier build\n",
        },
      },
    );
  });

  test("teardown: last listener first, interrupt at once, close after every settle", async () => {
    const heard: string[][] = [];
    const listener = (name: string, broken = false): RunListener => {
      const hear = (hook: string) => () => {
        heard.push([hook, name]);
        if (broken) throw new Error(`${name} ${hook} broke`);
      };
      return {
        settle: (nodeState) => void heard.push(["settle", name, nodeState.node.name]),
        close: hear("close"),
        interrupt: hear("interrupt"),
      };
    };
    const { store, events } = storeOf([listener("first"), listener("second", true)]);
    store.begin({ title: "main", nodes: [a] });
    events(...started(a), built(a, "ka"));
    // One that throws still lets the first, a terminal restoring its streams, have its say.
    const thrown = [
      await Promise.resolve().then(store.interrupt).catch(errorMessage),
      await store.close().catch(errorMessage),
    ];
    assert.deepEqual(thrown, ["second interrupt broke", "second close broke"]);
    assert.deepEqual(heard, [
      ["interrupt", "second"],
      ["interrupt", "first"],
      ["settle", "first", "a"],
      ["settle", "second", "a"],
      ["close", "second"],
      ["close", "first"],
    ]);
  });

  test("an immediate hook that throws fails the run, and the others still hear", async () => {
    const heard: string[][] = [];
    const pass = { title: "main", nodes: [a] };
    const { store, events } = storeOf([
      {
        immediate: {
          output: () => {
            throw new Error("a broken listener");
          },
        },
      },
      { immediate: { output: (_nodeState, lines) => void heard.push(lines) } },
    ]);
    store.begin(pass);
    events(...started(a), printed(a, "a out\n"));
    const error = await store.report(pass).catch(errorMessage);
    assert.deepEqual({ heard, error }, { heard: [["a out"]], error: "a broken listener" });
  });

  test("output as a terminal leaves it", () => {
    const feed = (chunks: string[]) => {
      const completed: string[] = [];
      let nodeState: NodeState = initialNodeState(node("n"));
      for (const chunk of chunks) {
        completed.push(...completedLines(nodeState.unfinishedLine, chunk));
        nodeState = nodeReducer(nodeState, { type: "output", node: "n", chunk, occurredAt: 0 });
      }
      return { completed, unfinishedLine: nodeState.unfinishedLine, lastLine: nodeState.lastLine };
    };
    const redraw = (i: number) => `${i + 1} of 10000 ###`;
    assert.deepEqual(
      {
        blank: feed(["a\n", "\n", "b\n"]),
        progress: feed(["downloading 10%\rdownloading 90%\r", "done\r\n"]),
        redrawsLeading: feed(Array.from({ length: 10_000 }, (_, i) => `\r${redraw(i)}`)),
        redrawsTrailing: feed([
          ...Array.from({ length: 10_000 }, (_, i) => `${redraw(i)}\r`),
          "done",
        ]),
        redrawsAfterNewline: feed([
          `start\n${Array.from({ length: 20 }, (_, i) => `${i + 1}/20 ###\r`).join("")}`,
        ]),
        splitEscape: feed(["abc\x1b[3", "1mred\x1b[0m\n"]),
        controls: feed(["step\u0085done\x07\tok\n", "soft\u00adhyphen\n"]),
        debug: feed(["tsc ok\n::debug::walking src\n", "::debug::walking lib"]),
        unfinished: feed(["compiling\n", "50%"]),
        warning: feed(["building\n", "::warning title=build::careful\n"]),
      },
      {
        blank: { completed: ["a", "", "b"], unfinishedLine: "", lastLine: "b" },
        progress: { completed: ["done"], unfinishedLine: "", lastLine: "done" },
        redrawsLeading: { completed: [], unfinishedLine: "10000 of 10000 ###", lastLine: "" },
        redrawsTrailing: { completed: [], unfinishedLine: "done", lastLine: "" },
        redrawsAfterNewline: {
          completed: ["start"],
          unfinishedLine: "20/20 ###\r",
          lastLine: "start",
        },
        splitEscape: { completed: ["abcred"], unfinishedLine: "", lastLine: "abcred" },
        controls: {
          completed: ["stepdone\tok", "soft\u00adhyphen"],
          unfinishedLine: "",
          lastLine: "soft\u00adhyphen",
        },
        debug: {
          completed: ["tsc ok"],
          unfinishedLine: "::debug::walking lib",
          lastLine: "tsc ok",
        },
        unfinished: { completed: ["compiling"], unfinishedLine: "50%", lastLine: "compiling" },
        // The terminal prints a warning apart, so it is never a node's last line.
        warning: {
          completed: ["building", "::warning title=build::careful"],
          unfinishedLine: "",
          lastLine: "building",
        },
      },
    );
  });

  test("durations, timeouts and outcomes in a few words: a timeout is the node's own, not an error an action names one", () => {
    const failure = (timeoutMs: number, timedOut: boolean) => {
      const error = { name: "TimeoutError", message: "fetch timed out" };
      const nodeState = nodeReducer(initialNodeState({ ...node("n"), timeoutMs }), {
        type: "result",
        node: "n",
        result: {
          name: "n",
          actionKey: "k",
          status: "failed",
          error,
          elapsed: 1,
          ...(timedOut && { timedOut }),
        },
        occurredAt: 0,
      });
      assert(nodeState.status === "failed");
      return failureMessage(nodeState);
    };
    const ended = (result: Result): NodeReport => ({ node: node(result.name), result });
    const done = ended(builtResult(node("done"), "k"));
    const skipped = ended(
      resultOf(node("skipped"), { actionKey: "", status: "dep-failed", dep: "b" }),
    );
    assert.deepEqual(
      {
        durations: [450, 1500].map(formatDuration),
        failures: [failure(60_000, true), failure(100_000, true), failure(60_000, false)],
        outcomes: [[done], [done, skipped]].map((n) => reportHeadline(n)),
      },
      {
        durations: ["450ms", "1.5s"],
        failures: [
          "The action 'n' has timed out after 1 minute.",
          "The action 'n' has timed out after 1.67 minutes.",
          "fetch timed out",
        ],
        outcomes: ["✔︎ 1 node succeeded", "⏭︎ 1 node skipped, a dependency failed"],
      },
    );
  });

  test("the warnings in a log, as GitHub's runner reads them", () => {
    assert.deepEqual(
      warningMessages([
        "  ::warning title=lint%3Aa::50%25 done,%0Ano more",
        "::WARNING file=a.ts,line=3::shout",
        "::notice::a notice",
        "echo ::warning::not a command",
        "::stop-commands::pause",
        "::warning::held",
        "::pause::",
        "::warning::after",
      ]),
      [
        "50% done,\nno more",
        "shout",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "after",
      ],
    );
  });

  test("a skipped node's causes are the engine's root causes: the failures along its required deps, through the skipped nodes between, and not a failed settled dep", async () => {
    const failing = new Set(["test", "upload"]);
    const { ports, fs } = createTestPorts({
      exec: {
        run: async ([program = ""]) => {
          const code = failing.has(program) ? 1 : 0;
          return { ended: "exited", code, stdout: "", stderr: "", output: "", ok: code === 0 };
        },
      },
    });
    const graph = new Graph<Ports>();
    const db = addCommand(graph, { name: "up:db", cmd: ["up"] });
    const check = addCommand(graph, { name: "test", cmd: ["test"], deps: { db } });
    const e2e = addCommand(graph, { name: "e2e", cmd: ["e2e"], deps: { check } });
    addCommand(graph, { name: "deploy", cmd: ["deploy"], deps: { e2e } });
    // After a failed `settled` dep: a failure of its own, whose block lists the dep.
    const upload = addCommand(graph, {
      name: "upload",
      cmd: ["upload"],
      deps: { db, check: settledDep(check) },
    });
    addCommand(graph, {
      name: "publish",
      cmd: ["publish"],
      deps: { upload, check: settledDep(check) },
    });
    const store = createRunStore({ fs, durationsFile: DURATIONS_FILE, listeners: [] });
    store.begin({ title: "main", nodes: graph.describe() });
    await execute(
      graph,
      { ports, fs, cacheDir: "/cache", clock: steppingClock() },
      { onEvent: (event) => store.onEvent(event) },
    );
    const run = store.getState();
    const stateOf = (name: string) => {
      const nodeState = run.nodes.get(name);
      assert.ok(nodeState, name);
      return nodeState;
    };
    assert.deepEqual(
      {
        causesOfDeploy: selectors.causesOf(stateOf("deploy")),
        causesOfPublish: selectors.causesOf(stateOf("publish")),
        skippedBecauseOfTest: selectors.skippedBecauseOf(run, "test"),
        dependencyFailuresOfUpload: selectors
          .getDependencyFailures(run, stateOf("upload"))
          .map((depState) => depState.node.name),
      },
      {
        causesOfDeploy: ["test"],
        causesOfPublish: ["upload"],
        skippedBecauseOfTest: ["e2e", "deploy"],
        dependencyFailuresOfUpload: ["test"],
      },
    );
  });
});
