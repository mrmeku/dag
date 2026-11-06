import {
  createMemoryFileSystem,
  errorMessage,
  type ExecutionEvent,
  type JsonValue,
  type MemoryFileSystem,
  type Node,
  type NodeResult,
} from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { selectors, type RunState } from "../kernel/index.ts";
import { createRunStore, durationsFileOf, type RunListener } from "./index.ts";

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
type Settled<R = NodeResult> = R extends unknown ? Omit<R, "name"> : never;
const resultOf = (n: Node, result: Settled): NodeResult => ({ name: n.name, ...result });
const resultEvent = (result: NodeResult): ExecutionEvent => ({
  type: "result",
  node: result.name,
  result,
  occurredAt: 0,
});
const settled = (n: Node, result: Settled): ExecutionEvent => resultEvent(resultOf(n, result));
const entryOf = (key: string) => ({ outputs: { out: key }, contentHash: "h", outputHashes: {} });
const builtResult = (n: Node, key: string, elapsed = 1000): NodeResult =>
  resultOf(n, {
    status: "succeeded",
    details: { actionKey: key, entry: entryOf(key), actionRan: true, elapsed },
  });
const hitResult = (n: Node, key: string): NodeResult =>
  resultOf(n, {
    status: "succeeded",
    details: { actionKey: key, entry: entryOf(key), actionRan: false },
  });
const failedResult = (n: Node, key: string, message: string, cause?: JsonValue): NodeResult =>
  resultOf(n, {
    status: "failed",
    error: { name: "Error", message, ...(cause !== undefined && { cause }) },
    details: { actionKey: key, elapsed: 1000 },
  });
const built = (n: Node, key: string, elapsed?: number): ExecutionEvent =>
  resultEvent(builtResult(n, key, elapsed));
const failed = (n: Node, key: string, message: string, cause?: JsonValue): ExecutionEvent =>
  resultEvent(failedResult(n, key, message, cause));
const started = (n: Node): ExecutionEvent[] => [
  { type: "dispatch", node: n.name, occurredAt: 0 },
  { type: "start", node: n.name, occurredAt: 0 },
];
const printed = (n: Node, chunk: string): ExecutionEvent => ({
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
const buildLogsOf = (fs: MemoryFileSystem) =>
  Object.fromEntries(
    [...fs.files]
      .filter(([path]) => path.startsWith(`${BUILD_LOG_DIR}/`))
      .map(([path, file]) => [path, file.data]),
  );

/** A store, and its events as an engine stamps them: a second apart, what a node prints aside. */
function storeOf(listeners: RunListener[]) {
  const fs = createMemoryFileSystem(files);
  const store = createRunStore({
    fs,
    buildLogDir: BUILD_LOG_DIR,
    durationsFile: DURATIONS_FILE,
    listeners,
  });
  let now = -1000;
  return {
    fs,
    store,
    events: (...events: ExecutionEvent[]) =>
      events.forEach((event) =>
        store.onEvent(event.type === "output" ? event : { ...event, occurredAt: (now += 1000) }),
      ),
  };
}

/**
 * What one listener hears of a run, then of a post pass begun while the run's settles are still
 * being read, re-running a node the run cancelled, it running while they are told.
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
    resultEvent(hitResult(c, "kc")),
    settled(d, { status: "dep-failed", dep: "b" }),
    failed(f, "kf", "upload refused", { name: "Error", message: "ECONNREFUSED" }),
    ...started(save),
    settled(save, { status: "cancelled", details: { actionKey: "ks" } }),
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
  status: "dep-failed",
  dep: "b",
  rootCauses: ["b"],
});
const cancelledRunning = resultOf(c, {
  status: "cancelled",
  details: { actionKey: "kc", elapsed: 1000 },
});

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
      ["settle", "a", "succeeded", ["a out", "part"], "no command"],
      ["start", "f", "running", 1500],
      ["settle", "b", "failed", ["b out"], command],
      ["settle", "c", "succeeded", ["c from an earlier run"], "no command"],
      ["settle", "d", "dep-failed", [], "no command"],
      ["settle", "f", "failed", [], "no command"],
      ["start", "save", "running", undefined],
      ["settle", "save", "cancelled", [], "no command"],
      ["begin", "post", false],
      ["start", "save", "running", undefined],
      ["immediate.output", "save", ["saved"]],
      ["settle", "save", "succeeded", ["saved"], "no command"],
      ["finish", "post", ["save succeeded in 1000ms"]],
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
    // What dagraph emits for a `run` task whose input file is missing, and for its settled
    // dependant whose start the store heard but whose record then failed.
    const hashNode: Node = { name: "hash", kind: "run", deps: [] };
    const recordedNode: Node = {
      name: "recorded",
      kind: "run",
      deps: ["hash"],
      settledDeps: ["hash"],
      cacheable: false,
    };
    const hashResult: NodeResult = {
      name: "hash",
      status: "failed",
      error: { name: "Error", message: "ENOENT: src/a.ts" },
    };
    const recordedResult: NodeResult = {
      name: "recorded",
      status: "failed",
      error: { name: "Error", message: "disk full" },
      details: { actionKey: "kr" },
    };
    const fs = createMemoryFileSystem();
    const store = createRunStore({ fs, durationsFile: DURATIONS_FILE, listeners: [] });
    const pass = { title: "main", nodes: [hashNode, recordedNode] };
    store.begin(pass);
    for (const event of [
      { type: "dispatch", node: "hash", occurredAt: 0 },
      { ...resultEvent(hashResult), occurredAt: 1000 },
      { type: "dispatch", node: "recorded", occurredAt: 2000 },
      { type: "start", node: "recorded", occurredAt: 3000 },
      { ...resultEvent(recordedResult), occurredAt: 4000 },
    ] satisfies ExecutionEvent[])
      store.onEvent(event);
    const reports = await store.report(pass);
    await store.writeDurations();
    assert.deepEqual(
      {
        hash: store.getState().nodes.get("hash"),
        reports,
        durations: fs.files.has(DURATIONS_FILE),
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
          { node: recordedNode, result: recordedResult },
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

  test("a failed durations write resolves, and fails the next report", async () => {
    const pass = { title: "main", nodes: [a] };
    const { fs, store, events } = storeOf([]);
    const { writeText } = fs;
    fs.writeText = async (path, text) => {
      if (path === DURATIONS_FILE) throw new Error("ENOSPC: no space left on device, write");
      return writeText(path, text);
    };
    store.begin(pass);
    events(...started(a), built(a, "ka"));
    assert.deepEqual(
      {
        written: await store.writeDurations(),
        report: await store.report(pass).catch(errorMessage),
      },
      { written: undefined, report: "ENOSPC: no space left on device, write" },
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
    events({ type: "dispatch", node: "c", occurredAt: 0 }, resultEvent(hitResult(c, "kc")));
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

  test("closing hooks: last listener first, every one though some throw, the first error rethrown, interrupt at once, close after every settle", async () => {
    const heard: string[][] = [];
    const listener = (name: string): RunListener => {
      const hear = (hook: string) => () => {
        heard.push([hook, name]);
        throw new Error(`${name} ${hook} broke`);
      };
      return {
        settle: (nodeState) => void heard.push(["settle", name, nodeState.node.name]),
        close: hear("close"),
        interrupt: hear("interrupt"),
      };
    };
    const { store, events } = storeOf([listener("first"), listener("second")]);
    store.begin({ title: "main", nodes: [a] });
    events(...started(a), built(a, "ka"));
    // Each throws, and still the first, a terminal restoring its streams, has its say.
    const thrown = [
      await Promise.resolve().then(store.interrupt).catch(errorMessage),
      await store.close().catch(errorMessage),
    ];
    assert.deepEqual(
      { thrown, heard },
      {
        thrown: ["second interrupt broke", "second close broke"],
        heard: [
          ["interrupt", "second"],
          ["interrupt", "first"],
          ["settle", "first", "a"],
          ["settle", "second", "a"],
          ["close", "second"],
          ["close", "first"],
        ],
      },
    );
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

  test("a listener is given the state once, as the store is made, and reads it live", async () => {
    const attached: (() => RunState)[] = [];
    const { store, events } = storeOf([{ attach: (getState) => void attached.push(getState) }]);
    const pass = { title: "main", nodes: [a] };
    store.begin(pass);
    events(...started(a));
    assert.deepEqual(
      attached.map((getState) => getState().nodes.get("a")?.status),
      ["running"],
    );
  });

  test("with no build log dir, a built node's log is kept only in the run and a hit shows none", async () => {
    const fs = createMemoryFileSystem(files);
    const store = createRunStore({ fs, durationsFile: DURATIONS_FILE, listeners: [] });
    const pass = { title: "main", nodes: [a, c] };
    store.begin(pass);
    const events: ExecutionEvent[] = [
      ...started(a),
      printed(a, "a out\n"),
      built(a, "ka"),
      { type: "dispatch", node: "c", occurredAt: 0 },
      resultEvent(hitResult(c, "kc")),
    ];
    for (const event of events) store.onEvent(event);
    await store.report(pass);
    assert.deepEqual(
      { a: await store.log("a"), c: await store.log("c"), buildLogs: buildLogsOf(fs) },
      {
        a: ["a out"],
        c: [],
        buildLogs: Object.fromEntries(
          Object.entries(files).filter(([path]) => path.startsWith(`${BUILD_LOG_DIR}/`)),
        ),
      },
    );
  });
});

test("the durations file is named by the workflow file's path from the working directory, inside the durations dir", () => {
  const fileOf = (workflowFile?: string) => durationsFileOf(".dag/durations", workflowFile);
  assert.deepEqual(
    {
      ci: fileOf("scripts/ci.ts"),
      sameCi: fileOf("./scripts/../scripts/ci.ts"),
      release: fileOf("scripts/release.ts"),
      outside: fileOf("../other/ci.ts"),
      none: fileOf(),
    },
    {
      ci: ".dag/durations/scripts/ci.ts.json",
      sameCi: ".dag/durations/scripts/ci.ts.json",
      release: ".dag/durations/scripts/release.ts.json",
      outside: ".dag/durations/%2E%2E/other/ci.ts.json",
      none: ".dag/durations/run.json",
    },
  );
});
