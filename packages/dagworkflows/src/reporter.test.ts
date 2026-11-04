import type { ExecutionEvent, Node, NodeResult } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { STATUS_ICON } from "./config.ts";
import { createTestPorts } from "./ports/memory.ts";
import { createReporter } from "./reporter.ts";
import {
  renderDag,
  renderStatus,
  renderTable,
  type RunReport,
  type SummaryRenderer,
} from "./summary.ts";

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
async function play(summary?: readonly SummaryRenderer[]) {
  const { ports, fs, rec } = createTestPorts({
    files: {
      [`${BUILD_LOG_DIR}/k2.log`]: "from an earlier run\n",
      [DURATIONS_FILE]: JSON.stringify({ durations: { a: 500, b: 2000, c: 3000 } }),
    },
  });
  const reporter = createReporter(ports, {
    buildLogDir: BUILD_LOG_DIR,
    durationsFile: DURATIONS_FILE,
    nodes: NODES,
    rerunCommand: "npx --no dag run ci.ts",
    ...(summary && { summary }),
  });
  for (const ev of EVENTS) reporter.onEvent(ev);
  return { fs, rec, ...(await reporter.finish(RESULTS)) };
}

const CLASSDEFS = [
  "  classDef done fill:#dcfce7,stroke:#16a34a,color:#14532d",
  "  classDef cached fill:#f1f5f9,stroke:#94a3b8,color:#475569",
  "  classDef fail fill:#fee2e2,stroke:#dc2626,color:#7f1d1d",
  "  classDef skipped fill:#f8fafc,stroke:#cbd5e1,stroke-dasharray:4 4,color:#94a3b8",
];

describe("reporter", () => {
  test("a timeout of a minute or more reads in minutes with a timed_out check", async () => {
    const { ports, rec } = createTestPorts();
    const slow = { ...node("slow", "test"), timeoutMs: 900_000 };
    const half = { ...node("half", "test"), timeoutMs: 90_000 };
    const reporter = createReporter(ports, { durationsFile: DURATIONS_FILE, nodes: [slow, half] });
    const timedOut = (name: string, actionKey: string): NodeResult => {
      const error = { name: "TimeoutError", message: "timed out" };
      return {
        name,
        status: "failed",
        error,
        details: { actionKey, elapsed: 1000, timedOut: true },
      };
    };
    const results = [timedOut("slow", "k2"), timedOut("half", "")];
    // A node times out only once its action started.
    const events: ExecutionEvent[] = results.flatMap((result) => [
      { type: "dispatch", node: result.name, occurredAt: 0 },
      { type: "start", node: result.name, occurredAt: 0 },
      ...(result.name === "slow" ? [printed("slow", "partial\n")] : []),
      settled(result),
    ]);
    for (const ev of events) reporter.onEvent(ev);
    await reporter.finish(results);
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
          {
            title: `${STATUS_ICON.failed} half (1.0s)`,
            lines: ["── error ──", "The action 'half' has timed out after 1.5 minutes."],
          },
        ],
        conclusions: [
          ["slow", "timed_out"],
          ["half", "timed_out"],
        ],
      },
    );
  });

  test("start lines, live checks, groups with each node's log, plain lines for what did not run, annotations, the default summary and the closing recap; a cached node never starts, the last run is known from the first start, and a tool's debug commands are not part of the log", async () => {
    const { fs, rec, failed, markdown } = await play();

    assert.deepEqual(
      {
        log: rec.log,
        annotations: rec.annotations,
        checks: rec.checks,
        failed,
        durations: await parsed(fs.readText(DURATIONS_FILE)),
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
      },
    );

    assert.deepEqual(
      markdown,
      [
        "## run",
        "",
        "### ✖\uFE0E c failed",
        "",
        "built **1** · cached **1** · failed **1** · skipped **1** · wall 6.0s · parallelism 0.3× · cache 1/2 hits, 2.0s saved",
        "",
        "```mermaid",
        "gantt",
        "  title node timeline",
        "  dateFormat x",
        "  axisFormat %M:%S",
        "  section nodes",
        "  a :done, 1001000, 1002000",
        "  c :crit, 1006000, 1007000",
        "```",
        "",
        "critical path: a → c (2.0s)",
        "",
        "```mermaid",
        "flowchart LR",
        '  n0["✔\uFE0E a"]',
        '  n1["✔\uFE0E b"]',
        '  n2["✖\uFE0E c"]',
        '  n3["⏭\uFE0E d"]',
        "  n0 --> n2",
        "  n2 -.-> n3",
        "  class n0 done",
        "  class n1 cached",
        "  class n2 fail",
        "  class n3 skipped",
        ...CLASSDEFS,
        "```",
        "",
        "### failures",
        "",
        "<details><summary>✖\uFE0E c (1.0s)</summary>",
        "",
        "```text",
        "boom",
        "── error ──",
        "exit 1",
        "last line",
        "```",
        "",
        "</details>",
        "",
        "- ⏭\uFE0E d: skipped, dependency failed",
        "",
      ].join("\n"),
    );
  });

  test("a workflow's own renderers: built-ins in its order, its own, a filtered built-in, and one that throws", async () => {
    const tail = async (r: RunReport) => ["```text", ...(await r.log("c")).slice(-2), "```"];
    const withoutA = async (r: RunReport) => [
      "<details><summary>DAG without a</summary>",
      "",
      ...renderDag({ ...r, nodes: r.nodes.filter((n) => n.node.name !== "a") }),
      "",
      "</details>",
    ];
    const broken = () => {
      throw new Error("no coverage file");
    };
    const { rec, markdown } = await play([renderTable, tail, withoutA, broken, renderStatus]);
    assert.deepEqual(
      { warnings: rec.annotations.filter((a) => a.level === "warning"), markdown },
      {
        warnings: [
          {
            level: "warning",
            title: "dag",
            message: "step summary: broken failed: no coverage file",
          },
        ],
        markdown: [
          "## run",
          "",
          "| node | status | duration | vs last |",
          "| --- | --- | --- | --- |",
          "| a | done | 1.0s | +100% |",
          "| b | cached | 1.0s |  |",
          "| c | failed | 1.0s |  |",
          "| d | dep-failed |  |  |",
          "",
          "```text",
          "exit 1",
          "last line",
          "```",
          "",
          "<details><summary>DAG without a</summary>",
          "",
          "```mermaid",
          "flowchart LR",
          '  n0["✔\uFE0E b"]',
          '  n1["✖\uFE0E c"]',
          '  n2["⏭\uFE0E d"]',
          "  n1 -.-> n2",
          "  class n0 cached",
          "  class n1 fail",
          "  class n2 skipped",
          ...CLASSDEFS,
          "```",
          "",
          "</details>",
          "",
          "_(broken failed: no coverage file)_",
          "",
          "### ✖\uFE0E c failed",
          "",
          "built **1** · cached **1** · failed **1** · skipped **1** · wall 6.0s · parallelism 0.3× · cache 1/2 hits, 2.0s saved",
          "",
        ].join("\n"),
      },
    );
  });
});
