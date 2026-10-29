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
import { errorMessage, formatDuration, reportHeadline, warningMessages } from "./format.ts";
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
const settled = (n: Node, result: Settled): ExecEvent => ({
  type: "result",
  node: n.name,
  result: { name: n.name, ...result },
});
const built = (n: Node, key: string): ExecEvent =>
  settled(n, {
    actionKey: key,
    status: "done",
    outputs: { out: key },
    contentHash: "h",
    outputHashes: {},
    elapsed: 1,
  });
const failed = (n: Node, key: string, message: string, cause?: JsonValue): ExecEvent =>
  settled(n, {
    actionKey: key,
    status: "failed",
    error: { name: "Error", message, ...(cause !== undefined && { cause }) },
    elapsed: 1,
  });
const started = (n: Node): ExecEvent[] => [
  { type: "dispatch", node: n.name },
  { type: "start", node: n.name },
];
const printed = (n: Node, chunk: string): ExecEvent => ({ type: "output", node: n.name, chunk });
const command = { argv: ["make", "b"], cwd: ".", ended: "exited", code: 2 };
const files = {
  "/cas/last-run.json": JSON.stringify({ durations: { a: 500, f: 1500 } }),
  "/cas.logs/ka.log": "a out\npart",
  "/cas.logs/kb.log": "::debug::walking\nb out\n",
  "/cas.logs/kc.log": "c from an earlier run\n",
  "/cas.logs/kp.log": "saved\n",
};

function storeOf(listeners: RunListener[], lastRunAtBegin = false) {
  const { fs } = createTestPorts({ files });
  const store = createRunStore({
    fs,
    clock: steppingClock(),
    casBaseDir: "/cas",
    listeners,
    lastRunAtBegin,
  });
  return {
    fs,
    store,
    events: (...events: ExecEvent[]) => events.forEach((event) => store.onEvent(event)),
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
            (nodeState.status === "failed" && nodeState.command) || "no command",
          ]),
        finish: (pass, nodes) =>
          void heard.push([
            "finish",
            pass.title,
            nodes.map((node) => `${node.name} ${node.status} in ${node.duration}ms`),
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
    { type: "dispatch", node: "c" },
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

/**
 * A run of a built node, a failed one, one it skipped and one a cancel stopped, reported while
 * another still runs.
 */
async function failedRun() {
  const pass = { title: "main", nodes: [a, b, c, d, save] };
  const { fs, store, events } = storeOf([]);
  store.begin(pass);
  events(
    ...started(a),
    built(a, "ka"),
    ...started(b),
    failed(b, "kb", "make b exited 2", command),
    settled(d, { actionKey: "", status: "dep-failed", dep: "b" }),
    ...started(c),
    settled(c, { actionKey: "kc", status: "cancelled" }),
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
      { type: "dispatch", node: "a" },
      settled(a, {
        actionKey: "ka",
        status: "cached",
        outputs: { out: "ka" },
        contentHash: "h",
        outputHashes: {},
      }),
    );
    assert.deepEqual(await store.report(pass), [
      { ...a, status: "cached", start: 0, duration: 1000, previous: 500, outputs: { out: "ka" } },
    ]);
  });

  test("a pass's report: the nodes that settled, as they ended", async () => {
    const { reports } = await failedRun();
    assert.deepEqual(reports, [
      { ...a, status: "done", start: 1000, duration: 1000, previous: 500, outputs: { out: "ka" } },
      {
        ...b,
        status: "failed",
        start: 4000,
        duration: 1000,
        failedWhile: "running",
        error: "make b exited 2",
      },
      { ...c, status: "cancelled", start: 8000, duration: 1000 },
      { ...d, status: "dep-failed", error: "dependency b failed" },
    ]);
  });

  test("last-run.json: built and failed nodes over the last run, rewritten at the report", async () => {
    const { fs, store, pass } = await failedRun();
    fs.files.set("/cas/last-run.json", JSON.stringify({ durations: { a: 500 } }));
    await store.report(pass);
    assert.deepEqual(JSON.parse(await fs.readText("/cas/last-run.json")), {
      durations: { a: 1000, b: 1000, f: 1500 },
    });
  });

  test("a node that failed before its action started has no start, duration or last run; one whose start the store heard has them, though recording the start failed", async () => {
    const { ports, fs } = createTestPorts();
    const graph = new Graph<Ports>();
    const hash = addCommand(graph, {
      name: "hash",
      cmd: ["hash"],
      inputs: { "src/a.ts": file("src/a.ts") },
    });
    addCommand(graph, { name: "journal", cmd: ["journal"], deps: { hash: settledDep(hash) } });
    const store = createRunStore({ fs, clock: steppingClock(), casBaseDir: "/cas", listeners: [] });
    const pass = { title: "main", nodes: graph.describe() };
    const [hashNode, journalNode] = pass.nodes;
    store.begin(pass);
    await execute(
      graph,
      { ports, cache: new MemCache(), fs, casBaseDir: "/cas" },
      {
        // As the runner's history records a start, after the store has heard it.
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
        lastRun: await parsed(fs.readText("/cas/last-run.json")),
      },
      {
        hash: {
          node: hashNode,
          status: "failed",
          failedWhile: "waiting",
          actionKey: "",
          endedAt: 1000,
          error: "ENOENT: src/a.ts",
          timedOut: false,
          unfinishedLine: "",
          lastLine: "",
          printed: false,
          lineCount: 0,
          log: [],
        },
        reports: [
          { ...hashNode, status: "failed", failedWhile: "waiting", error: "ENOENT: src/a.ts" },
          {
            ...journalNode,
            status: "failed",
            start: 3000,
            duration: 1000,
            failedWhile: "running",
            error: "disk full",
          },
        ],
        lastRun: { durations: { journal: 1000 } },
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
    });
    const noAttemptDirectory = {
      ...fs,
      ensureDir: (path: string) =>
        path.includes("/tmp-") ? Promise.reject(new Error("EACCES: mkdir")) : fs.ensureDir(path),
    };
    const store = createRunStore({ fs, clock: steppingClock(), casBaseDir: "/cas", listeners: [] });
    const pass = { title: "main", nodes: graph.describe() };
    store.begin(pass);
    await execute(
      graph,
      { ports, cache: new MemCache(), fs: noAttemptDirectory, casBaseDir: "/cas" },
      { onEvent: (event) => store.onEvent(event) },
    );
    await store.report(pass);
    const actionKey = earlier?.actionKey ?? "";
    assert.deepEqual(
      {
        earlierLog: await fs.readText(`/cas.logs/${actionKey}.log`),
        stage: store.getState().nodes.get("stage"),
      },
      {
        earlierLog: output,
        stage: {
          node: pass.nodes[0],
          status: "failed",
          failedWhile: "waiting",
          actionKey,
          endedAt: 1000,
          error: "EACCES: mkdir",
          timedOut: false,
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
        reports: [{ ...a, status: "done", start: 1000, duration: 1000, outputs: { out: "ka" } }],
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
        nodeState = nodeReducer(nodeState, { type: "output", node: "n", chunk });
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

  test("durations, timeouts and outcomes in a few words", () => {
    const timedOut = (timeoutMs: number) => {
      const error = { name: "TimeoutError", message: "timed out" };
      const failed = nodeReducer(initialNodeState({ ...node("n"), timeoutMs }), {
        type: "result",
        node: "n",
        result: { name: "n", actionKey: "k", status: "failed", error, elapsed: 1 },
        occurredAt: 0,
      });
      assert(failed.status === "failed");
      return failed.error;
    };
    const ended = (status: NodeReport["status"]): NodeReport => ({ ...node(status), status });
    assert.deepEqual(
      {
        durations: [450, 1500].map(formatDuration),
        timeouts: [60_000, 100_000].map(timedOut),
        outcomes: [[ended("done")], [ended("done"), ended("dep-failed")]].map((n) =>
          reportHeadline(n),
        ),
      },
      {
        durations: ["450ms", "1.5s"],
        timeouts: [
          "The action 'n' has timed out after 1 minute.",
          "The action 'n' has timed out after 1.67 minutes.",
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

  test("a skipped node goes back through the skipped nodes between to the failures that caused it", () => {
    const db = node("up:db");
    const check = node("test", ["up:db"]);
    const e2e = node("e2e", ["test"]);
    const deploy = node("deploy", ["e2e"]);
    // After a failed `settled` dep: a failure of its own, whose block lists the dep.
    const upload = node("upload", ["up:db", "test"]);
    const { store, events } = storeOf([]);
    store.begin({ title: "main", nodes: [db, check, e2e, deploy, upload] });
    events(
      built(db, "kdb"),
      failed(check, "kt", "make b exited 2", command),
      settled(e2e, { actionKey: "", status: "dep-failed", dep: "test" }),
      settled(deploy, { actionKey: "", status: "dep-failed", dep: "e2e" }),
      failed(upload, "ku", "upload exited 3", { ...command, argv: ["upload"], code: 3 }),
    );
    const run = store.getState();
    const stateOf = (name: string) => {
      const nodeState = run.nodes.get(name);
      assert.ok(nodeState, name);
      return nodeState;
    };
    assert.deepEqual(
      {
        causesOfDeploy: selectors.causesOf(run, stateOf("deploy")),
        skippedBecauseOfTest: selectors.skippedBecauseOf(run, "test"),
        dependencyFailuresOfUpload: selectors
          .getDependencyFailures(run, stateOf("upload"))
          .map((depState) => depState.node.name),
      },
      {
        causesOfDeploy: ["test"],
        skippedBecauseOfTest: ["e2e", "deploy"],
        dependencyFailuresOfUpload: ["test"],
      },
    );
  });
});
