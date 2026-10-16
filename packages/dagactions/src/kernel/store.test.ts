import type { ExecEvent, Node } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createTestPorts, steppingClock } from "../ports/memory.ts";
import { formatDuration, reportHeadline } from "./format.ts";
import type { NodeReport } from "./report.ts";
import { completedLines, initialNodeState, nodeReducer, type NodeState } from "./run-slice.ts";
import { createRunStore, type RunListener } from "./store.ts";

const node = (name: string, deps: string[] = []): Node => ({ name, kind: name, deps, config: "" });
const [a, b, c, d, f, save] = [
  node("a"),
  node("b"),
  node("c"),
  node("d", ["b"]),
  node("f", ["a"]),
  node("save"),
];
const built = (n: Node, key: string): ExecEvent => {
  return { type: "done", node: n, actionKey: key, outputs: key, contentHash: "h", elapsed: 1 };
};
const failed = (n: Node, key: string, error: Error): ExecEvent => {
  return { type: "fail", node: n, actionKey: key, error, elapsed: 1 };
};
const started = (n: Node): ExecEvent[] => [
  { type: "dispatch", node: n },
  { type: "start", node: n },
];
const command = { argv: ["make", "b"], cwd: ".", code: 2 };
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
            (nodeState.status === "fail" && nodeState.command) || "no command",
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
  events(...started(a));
  store.onOutput(a, "a out\npa");
  store.onOutput(a, "rt");
  events(...started(b));
  store.onOutput(b, "::debug::walking\nb out\n");
  events(
    built(a, "ka"),
    ...started(f),
    failed(b, "kb", new Error("make b exited 2", { cause: command })),
    { type: "dispatch", node: c },
    { type: "cached", node: c, actionKey: "kc", outputs: "kc", contentHash: "h" },
    { type: "dep-failed", node: d, error: new Error("dependency b failed") },
    failed(f, "kf", new Error("upload refused", { cause: new Error("ECONNREFUSED") })),
    ...started(save),
    { type: "cancelled", node: save, actionKey: "ks" },
  );
  store.begin(post);
  events(...started(save));
  await new Promise(setImmediate);
  store.onOutput(save, "saved\n");
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
    failed(b, "kb", new Error("make b exited 2", { cause: command })),
    { type: "dep-failed", node: d, error: new Error("dependency b failed") },
    ...started(c),
    { type: "cancelled", node: c, actionKey: "kc" },
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
      ["settle", "b", "fail", ["b out"], command],
      ["settle", "c", "cached", ["c from an earlier run"], "no command"],
      ["settle", "d", "dep-failed", [], "no command"],
      ["settle", "f", "fail", [], "no command"],
      ["start", "save", "running", undefined],
      ["settle", "save", "cancelled", [], "no command"],
      ["begin", "post", false],
      ["start", "save", "running", undefined],
      ["immediate.output", "save", ["saved"]],
      ["settle", "save", "done", ["saved"], "no command"],
      ["finish", "post", ["save done in 2000ms"]],
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
      { type: "dispatch", node: a },
      { type: "cached", node: a, actionKey: "ka", outputs: "ka", contentHash: "h" },
    );
    assert.deepEqual(await store.report(pass), [
      { ...a, status: "cached", start: 0, duration: 1000, previous: 500, outputs: "ka" },
    ]);
  });

  test("a pass's report: the nodes that settled, as they ended", async () => {
    const { reports } = await failedRun();
    assert.deepEqual(reports, [
      { ...a, status: "done", start: 0, duration: 2000, previous: 500, outputs: "ka" },
      { ...b, status: "fail", start: 3000, duration: 2000, error: "make b exited 2" },
      { ...c, status: "cancelled", start: 7000, duration: 2000 },
      { ...d, status: "dep-failed", error: "dependency b failed" },
    ]);
  });

  test("last-run.json: built and failed nodes over the last run, rewritten at the report", async () => {
    const { fs, store, pass } = await failedRun();
    fs.files.set("/cas/last-run.json", JSON.stringify({ durations: { a: 500 } }));
    await store.report(pass);
    assert.deepEqual(JSON.parse(fs.files.get("/cas/last-run.json") as string), {
      durations: { a: 2000, b: 2000, f: 1500 },
    });
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
        file: JSON.parse(fs.files.get("/cas/last-run.json") as string),
      },
      {
        reports: [{ ...a, status: "done", start: 0, duration: 2000, outputs: "ka" }],
        file: { durations: { a: 2000 } },
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
      await Promise.resolve()
        .then(store.interrupt)
        .catch((e: Error) => e.message),
      await store.close().catch((e: Error) => e.message),
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
    events(...started(a));
    store.onOutput(a, "a out\n");
    const error = await store.report(pass).catch((e: Error) => e.message);
    assert.deepEqual({ heard, error }, { heard: [["a out"]], error: "a broken listener" });
  });

  test("output as a terminal leaves it", () => {
    const feed = (chunks: string[]) => {
      const completed: string[] = [];
      let nodeState: NodeState = initialNodeState(node("n"));
      for (const chunk of chunks) {
        completed.push(...completedLines(nodeState.unfinishedLine, chunk));
        nodeState = nodeReducer(nodeState, { type: "outputPrinted", node: nodeState.node, chunk });
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
      },
    );
  });

  test("durations, timeouts and outcomes in a few words", () => {
    const timedOut = (timeoutMs: number) => {
      const error = Object.assign(new Error("timed out"), { name: "TimeoutError" });
      const n = { ...node("n"), timeoutMs };
      const failed = nodeReducer(initialNodeState(n), {
        type: "fail",
        node: n,
        actionKey: "k",
        error,
        elapsed: 1,
        occurredAt: 0,
      });
      assert(failed.status === "fail");
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
});
