import {
  execute,
  file,
  Graph,
  MemCache,
  settled as settledDep,
  type ExecEvent,
  type JsonValue,
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
const files = {
  "/cas/last-run.json": JSON.stringify({ durations: { a: 500, f: 1500 } }),
  "/cas.logs/ka.log": "a out\npart",
  "/cas.logs/kb.log": "::debug::walking\nb out\n",
  "/cas.logs/kc.log": "c from an earlier run\n",
  "/cas.logs/kp.log": "saved\n",
};

/** A store, and its events as an engine stamps them: a second apart, what a node prints aside. */
function storeOf(listeners: RunListener[], lastRunAtBegin = false) {
  const { fs } = createTestPorts({ files });
  const store = createRunStore({ fs, casBaseDir: "/cas", listeners, lastRunAtBegin });
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
async function transcript(lastRunAtBegin: boolean) {
  const main = { title: "main", nodes: [a, b, c, d, f, save] };
  const post = { title: "post", nodes: [save] };
  const heard: unknown[][] = [];
  const { store, events } = storeOf(
    [
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
    ],
    lastRunAtBegin,
  );
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
    built(a, "ka", 600),
    ...started(b),
    failed(b, "kb", "make b exited 2", command),
    resultEvent(skippedByB),
    ...started(c),
    resultEvent(cancelledRunning),
    ...started(save),
  );
  return { fs, store, pass, reports: await store.report(pass) };
}

describe("run store", () => {
  test("what a listener hears, then of a post pass begun while the run's settles are read", async () => {
    assert.deepEqual(await transcript(false), [
      ["immediate.start", "a"],
      ["immediate.output", "a", ["a out"]],
      ["immediate.start", "b"],
      ["immediate.output", "b", ["b out"]],
      ["immediate.output", "a", ["part"]],
      ["immediate.start", "f"],
      ["immediate.start", "save"],
      ["immediate.start", "save"],
      ["begin", "main", true],
      ["start", "a", "running", undefined],
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

  test("with lastRunAtBegin, the first start knows its last run", async () => {
    assert.deepEqual(
      (await transcript(true)).filter(([hook]) => hook === "start"),
      [
        ["start", "a", "running", 500],
        ["start", "b", "running", undefined],
        ["start", "f", "running", 1500],
        ["start", "save", "running", undefined],
        ["start", "save", "running", undefined],
      ],
    );
  });

  test("a pass of cache hits knows the last run by its report", async () => {
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

  test("last-run.json: built and failed nodes over the last run, rewritten at the report", async () => {
    const { fs, store, pass } = await failedRun();
    fs.files.set("/cas/last-run.json", JSON.stringify({ durations: { a: 500 } }));
    await store.report(pass);
    assert.deepEqual(JSON.parse(await fs.readText("/cas/last-run.json")), {
      durations: { a: 600, b: 1000, f: 1500 },
    });
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
    const store = createRunStore({ fs, casBaseDir: "/cas", listeners: [] });
    const pass = { title: "main", nodes: graph.describe() };
    const [hashNode, journalNode] = pass.nodes;
    store.begin(pass);
    const [hashResult, journalResult] = await execute(
      graph,
      { ports, cache: new MemCache(), fs, casBaseDir: "/cas", clock: steppingClock() },
      {
        // Heard before a record of the start that fails.
        onEvent: (event) => {
          store.onEvent(event);
          return event.type === "start" ? Promise.reject(new Error("disk full")) : undefined;
        },
      },
    );
    assert.deepEqual(
      {
        hash: store.getState().nodes.get("hash"),
        reports: await store.report(pass),
        lastRun: await fs.exists("/cas/last-run.json"),
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
        lastRun: false,
      },
    );
  });

  test("a node whose attempt could not be set up shows no log, though an earlier attempt left one under its key", async () => {
    const output = "an earlier attempt\n";
    const { ports, fs } = createTestPorts({
      files: { "src/a.ts": "a" },
      exec: {
        run: async () => ({
          ended: "exited",
          code: 0,
          stdout: output,
          stderr: "",
          output,
          ok: true,
        }),
      },
    });
    const graph = new Graph<Ports>();
    addCommand(graph, { name: "stage", cmd: ["stage"], inputs: { "src/a.ts": file("src/a.ts") } });
    const [earlier] = await execute(graph, {
      ports,
      cache: new MemCache(),
      fs,
      casBaseDir: "/cas",
      clock: Date,
    });
    const noAttemptDirectory = {
      ...fs,
      ensureDir: (path: string) =>
        path.includes("/tmp-") ? Promise.reject(new Error("EACCES: mkdir")) : fs.ensureDir(path),
    };
    const store = createRunStore({ fs, casBaseDir: "/cas", listeners: [] });
    const pass = { title: "main", nodes: graph.describe() };
    store.begin(pass);
    const [stage] = await execute(
      graph,
      {
        ports,
        cache: new MemCache(),
        fs: noAttemptDirectory,
        casBaseDir: "/cas",
        clock: steppingClock(),
      },
      { onEvent: (event) => store.onEvent(event) },
    );
    await store.report(pass);
    assert.deepEqual(
      {
        earlierLog: await fs.readText(`/cas.logs/${earlier?.actionKey ?? ""}.log`),
        sameKey: stage?.actionKey === earlier?.actionKey,
        stage: store.getState().nodes.get("stage"),
      },
      {
        earlierLog: output,
        sameKey: true,
        stage: {
          node: pass.nodes[0],
          status: "failed",
          result: stage,
          endedAt: 1000,
          unfinishedLine: "",
          lastLine: "",
          printed: false,
          lineCount: 0,
          log: [],
        },
      },
    );
  });

  test("a last-run.json it cannot read is no last run", async () => {
    const pass = { title: "main", nodes: [a] };
    const { fs, store, events } = storeOf([]);
    fs.files.set("/cas/last-run.json", "{ durations");
    store.begin(pass);
    events(...started(a), built(a, "ka"));
    assert.deepEqual(
      {
        reports: await store.report(pass),
        file: await parsed(fs.readText("/cas/last-run.json")),
      },
      {
        reports: [{ node: a, result: builtResult(a, "ka"), start: 1000, duration: 1000 }],
        file: { durations: { a: 1000 } },
      },
    );
  });

  test("a node's log as its group prints it", async () => {
    const { store } = await failedRun();
    assert.deepEqual(
      { a: await store.log("a"), b: await store.log("b"), d: await store.log("d") },
      {
        a: ["a out", "part"],
        b: ["b out", "── error ──", "make b exited 2"],
        d: ["dependency b failed"],
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
    const store = createRunStore({ fs, casBaseDir: "/cas", listeners: [] });
    store.begin({ title: "main", nodes: graph.describe() });
    await execute(
      graph,
      { ports, cache: new MemCache(), fs, casBaseDir: "/cas", clock: steppingClock() },
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
