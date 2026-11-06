import {
  createMemoryFileSystem,
  type ExecutionEvent,
  type Node,
  type NodeResult,
} from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { STATUS_ICON } from "../kernel/index.ts";
import { createRecordingHost } from "../recording/index.ts";
import type { RunReport } from "../run-store/index.ts";
import { createReporter, publishSummary } from "./index.ts";

const BUILD_LOG_DIR = "/build-logs";
const DURATIONS_FILE = "/durations/ci.ts.json";
const parsed = async (text: Promise<string>): Promise<unknown> => JSON.parse(await text);
const node = (name: string, kind: string, deps: string[] = [], settledDeps?: string[]): Node => ({
  name,
  kind,
  deps,
  ...(settledDeps && { settledDeps }),
});

const NODES = [
  node("a", "build"),
  node("b", "build"),
  node("c", "test", ["a"]),
  node("d", "require-all", ["c"], ["c"]),
];

const RESULTS: [NodeResult, NodeResult, NodeResult, NodeResult] = [
  {
    name: "a",
    status: "succeeded",
    details: {
      actionKey: "k1",
      entry: { outputs: { out: "x" }, contentHash: "h", outputHashes: {} },
      actionRan: true,
      elapsed: 1000,
    },
  },
  {
    name: "b",
    status: "succeeded",
    details: {
      actionKey: "k2",
      entry: { outputs: { out: "y" }, contentHash: "h", outputHashes: {} },
      actionRan: false,
    },
  },
  {
    name: "c",
    status: "failed",
    error: { name: "Error", message: "exit 1\nlast line" },
    details: { actionKey: "k3", elapsed: 1000 },
  },
  { name: "d", status: "dep-failed", dep: "c" },
];
const [A, B, C, D] = RESULTS;
const settled = (result: NodeResult, occurredAt = 0): ExecutionEvent => ({
  type: "result",
  node: result.name,
  result,
  occurredAt,
});
const printed = (name: string, chunk: string, occurredAt = 0): ExecutionEvent => ({
  type: "output",
  node: name,
  chunk,
  occurredAt,
});
/** A second apart, from 1,000,000 ms. */
const EVENTS: ExecutionEvent[] = [
  { type: "dispatch", node: "a", occurredAt: 1_000_000 },
  { type: "start", node: "a", occurredAt: 1_001_000 },
  printed("a", "ok line 1\nwarned\n", 1_001_000),
  printed("a", "ok line 2\n", 1_001_000),
  settled(A, 1_002_000),
  { type: "dispatch", node: "b", occurredAt: 1_003_000 },
  settled(B, 1_004_000),
  { type: "dispatch", node: "c", occurredAt: 1_005_000 },
  { type: "start", node: "c", occurredAt: 1_006_000 },
  printed("c", "::debug::walking\nboom\n", 1_006_000),
  settled(C, 1_007_000),
  settled(D, 1_008_000),
];

/** a built and c failed, each printing, b cached with the log of an earlier build, d skipped; a and b ran before. */
async function play() {
  const fs = createMemoryFileSystem({
    [`${BUILD_LOG_DIR}/k2.log`]: "from an earlier run\n",
    [DURATIONS_FILE]: JSON.stringify({ durations: { a: 500, b: 2000, c: 3000 } }),
  });
  const rec = createRecordingHost();
  const reporter = createReporter(
    { host: rec.host, fs },
    {
      buildLogDir: BUILD_LOG_DIR,
      durationsFile: DURATIONS_FILE,
      nodes: NODES,
      rerunCommand: "npx --no dag run ci.ts",
    },
  );
  for (const ev of EVENTS) reporter.onEvent(ev);
  return { fs, rec, ...(await reporter.finish(RESULTS)) };
}

/** The line that names each built-in renderer's block; the drawing is summary-renderers/' to test. */
const blockHeads = (markdown: string) =>
  markdown.split("\n").filter((line) => /^(#|gantt$|flowchart |critical path:)/.test(line));

/** A summary renderer that writes the report it is given: each node's times, then its log. */
async function renderReport({ nodes, log }: RunReport): Promise<string[]> {
  const lines: string[] = [];
  for (const { node, start, duration, previous } of nodes)
    lines.push(`${node.name} ${start} ${duration} ${previous}`, ...(await log(node.name)));
  return lines;
}

describe("reporter", () => {
  test("a timed-out node's group ends in its timeout and its check concludes timed_out", async () => {
    const rec = createRecordingHost();
    const slow = { ...node("slow", "test"), timeoutMs: 900_000 };
    const reporter = createReporter(
      { host: rec.host, fs: createMemoryFileSystem() },
      { durationsFile: DURATIONS_FILE, nodes: [slow] },
    );
    const result: NodeResult = {
      name: "slow",
      status: "failed",
      error: { name: "TimeoutError", message: "timed out" },
      details: { actionKey: "k2", elapsed: 1000, timedOut: true },
    };
    // A node times out only once its action started.
    const events: ExecutionEvent[] = [
      { type: "dispatch", node: "slow", occurredAt: 0 },
      { type: "start", node: "slow", occurredAt: 0 },
      printed("slow", "partial\n"),
      settled(result),
    ];
    for (const ev of events) reporter.onEvent(ev);
    await reporter.finish([result]);
    assert.deepEqual(
      {
        groups: rec.log.filter((e) => typeof e !== "string"),
        conclusions: rec.checks
          .filter((c) => c.status === "completed")
          .map((c) => [c.name, c.conclusion]),
      },
      {
        groups: [
          {
            title: `${STATUS_ICON.failed} slow (1.0s)`,
            lines: ["partial", "── error ──", "The action 'slow' has timed out after 15 minutes."],
          },
        ],
        conclusions: [["slow", "timed_out"]],
      },
    );
  });

  test("start lines, live checks, groups with each node's log, plain lines for what did not run, annotations, the built-in summary renderers and the closing recap; a cached node never starts, the last run is known from the first start, and a tool's debug commands are not part of the log", async () => {
    const { fs, rec, failed, markdown } = await play();

    assert.deepEqual(
      {
        log: rec.log,
        annotations: rec.annotations,
        checks: rec.checks,
        failed,
        durations: await parsed(fs.readText(DURATIONS_FILE)),
        defaultBlocks: blockHeads(markdown),
      },
      {
        log: [
          "▷ a (last run 500ms)",
          { title: "✔\uFE0E a (1.0s)", lines: ["ok line 1", "warned", "ok line 2"] },
          { title: "✔\uFE0E b (cached)", lines: ["from an earlier run"] },
          "▷ c (last run 3.0s)",
          { title: "✖\uFE0E c (1.0s)", lines: ["boom", "── error ──", "exit 1", "last line"] },
          "⏭\uFE0E d: skipped, dependency c failed",
          "",
          "✖\uFE0E c failed · run · built 1 · cached 1 · failed 1 · skipped 1 · wall 6.0s",
          "failed: c",
          "skipped, dependency failed: d",
          "reproduce: npx --no dag run ci.ts --only c",
        ],
        annotations: [{ level: "error", title: "c", message: "exit 1\nlast line" }],
        checks: [
          { name: "a", status: "in_progress", startedAt: "1970-01-01T00:16:41.000Z" },
          { name: "c", status: "in_progress", startedAt: "1970-01-01T00:16:46.000Z" },
          {
            name: "a",
            status: "completed",
            conclusion: "success",
            startedAt: "1970-01-01T00:16:41.000Z",
            completedAt: "1970-01-01T00:16:42.000Z",
            summary: "done in 1.0s",
          },
          {
            name: "b",
            status: "completed",
            conclusion: "success",
            startedAt: "1970-01-01T00:16:43.000Z",
            completedAt: "1970-01-01T00:16:44.000Z",
            summary: "cached",
          },
          {
            name: "c",
            status: "completed",
            conclusion: "failure",
            startedAt: "1970-01-01T00:16:46.000Z",
            completedAt: "1970-01-01T00:16:47.000Z",
            summary: "exit 1\nlast line",
          },
          {
            name: "d",
            status: "completed",
            conclusion: "skipped",
            completedAt: "1970-01-01T00:16:48.000Z",
            summary: "dependency c failed",
          },
        ],
        failed: 2,
        durations: { durations: { a: 1000, b: 2000, c: 1000 } },
        defaultBlocks: [
          "## run",
          "### ✖\uFE0E c failed",
          "gantt",
          "critical path: a → c (2.0s)",
          "flowchart LR",
          "### failures",
        ],
      },
    );
  });

  test("with no build log dir, a built node's log is drawn and kept nowhere", async () => {
    const fs = createMemoryFileSystem();
    const rec = createRecordingHost();
    const reporter = createReporter(
      { host: rec.host, fs },
      { durationsFile: DURATIONS_FILE, nodes: [node("a", "build")] },
    );
    for (const ev of EVENTS.slice(0, 5)) reporter.onEvent(ev);
    await reporter.finish([A]);
    assert.deepEqual(
      { group: rec.log[1], files: [...fs.files.keys()] },
      {
        group: { title: "✔\uFE0E a (1.0s)", lines: ["ok line 1", "warned", "ok line 2"] },
        files: [DURATIONS_FILE],
      },
    );
  });

  test("a task whose key needs a missing file fails before it starts: no start line, and the summary is given no start time or duration and only its error as its log", async () => {
    const rec = createRecordingHost();
    const lint = node("lint", "run");
    const error = "ENOENT: src/a.ts";
    const result: NodeResult = {
      name: "lint",
      status: "failed",
      error: { name: "Error", message: error },
    };
    const reporter = createReporter(
      { host: rec.host, fs: createMemoryFileSystem() },
      {
        durationsFile: DURATIONS_FILE,
        nodes: [lint],
        title: "ci.ts",
        rerunCommand: "npx --no dag run ci.ts",
        summary: [renderReport],
      },
    );
    reporter.onEvent({ type: "dispatch", node: "lint", occurredAt: 0 });
    reporter.onEvent(settled(result, 1000));
    await reporter.finish([result]);
    assert.deepEqual(
      { log: rec.log, checks: rec.checks, summary: rec.summaries.join("").split("\n") },
      {
        log: [
          { title: "✖︎ lint (not started)", lines: ["── error ──", error] },
          "",
          "✖︎ lint failed · ci.ts · built 0 · cached 0 · failed 1 · skipped 0 · wall 0ms",
          "failed: lint",
          "reproduce: npx --no dag run ci.ts --only lint",
        ],
        checks: [
          {
            name: "lint",
            status: "completed",
            conclusion: "failure",
            completedAt: "1970-01-01T00:00:01.000Z",
            summary: error,
          },
        ],
        summary: ["## ci.ts", "", "lint undefined undefined undefined", "── error ──", error, ""],
      },
    );
  });

  test("a renderer that throws is a warning titled dag and changes no outcome: the summary, even an empty one, is the markdown handed to the host", async () => {
    const rec = createRecordingHost();
    const status = () => ["### ✔\uFE0E all 2 nodes succeeded"];
    const report: RunReport = { nodes: [], log: async () => [] };
    const expected = "## ci.ts\n\n### ✔\uFE0E all 2 nodes succeeded\n\n_(#2 failed: boom)_\n";
    const resolved = [
      await publishSummary(rec.host, "ci.ts", report, [
        status,
        () => {
          throw new Error("boom");
        },
      ]),
      await publishSummary(rec.host, "ci.ts", report, [() => []]),
    ];
    assert.deepEqual(
      { annotations: rec.annotations, handed: rec.summaries, resolved },
      {
        annotations: [{ level: "warning", title: "dag", message: "step summary: #2 failed: boom" }],
        handed: [expected, ""],
        resolved: [expected, ""],
      },
    );
  });
});
