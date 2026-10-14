import type { ExecEvent, ExecResult, Node } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createTestPorts, steppingClock } from "./ports/memory.ts";
import { createReporter } from "./reporter.ts";
import {
  renderDag,
  renderStatus,
  renderTable,
  type RunReport,
  type SummaryRenderer,
} from "./summary.ts";

const CAS = "/cas";
const node = (name: string, kind: string, deps: string[] = [], optionalDeps?: string[]): Node => ({
  name,
  kind,
  deps,
  config: "",
  ...(optionalDeps && { optionalDeps }),
});

const NODES = [
  node("a", "build"),
  node("b", "build"),
  node("c", "test", ["a"]),
  node("d", "gate", ["c"], ["c"]),
];

const [A, B, C, D] = NODES as [Node, Node, Node, Node];
const EVENTS: ExecEvent[] = [
  { type: "dispatch", node: A },
  { type: "start", node: A },
  { type: "done", node: A, actionKey: "k1", outputs: "x", contentHash: "h", elapsed: 400 },
  { type: "settled", node: A },
  { type: "dispatch", node: B },
  { type: "cached", node: B, actionKey: "k2", outputs: "y", contentHash: "h" },
  { type: "settled", node: B },
  { type: "dispatch", node: C },
  { type: "start", node: C },
  { type: "fail", node: C, actionKey: "k3", error: new Error("exit 1\nlast line"), elapsed: 50 },
  { type: "settled", node: C },
  { type: "dep-failed", node: D, error: new Error("dependency c failed") },
  { type: "settled", node: D },
];
const RESULTS: ExecResult[] = [
  { name: "a", actionKey: "k1", status: "done", outputs: "x", contentHash: "h" },
  { name: "b", actionKey: "k2", status: "cached", outputs: "y", contentHash: "h" },
  { name: "c", actionKey: "k3", status: "fail", error: new Error("exit 1\nlast line") },
  { name: "d", actionKey: "", status: "dep-failed", error: new Error("dependency c failed") },
];

/** a built, b cached, c failed with logs in the CAS, d skipped; a and b ran before. */
async function play(summary?: readonly SummaryRenderer[]) {
  const { ports, fs, rec } = createTestPorts({
    files: {
      "/cas/k1/out/output.log": "ok line 1\nwarned\nok line 2\n",
      "/cas/k2/out/output.log": "from an earlier run\n",
      "/cas/k3/out/output.log": "::debug::walking\nboom\n",
      "/cas/last-run.json": JSON.stringify({ durations: { a: 500, b: 2000, c: 3000 } }),
    },
    clock: steppingClock(1_000_000, 1000),
  });
  const reporter = createReporter(ports, {
    casBaseDir: CAS,
    nodes: NODES,
    rerun: "npx dagactions run ci.ts",
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
  test("start lines, live checks, groups with CAS logs, plain lines for what did not run, annotations, the default summary and the closing recap; a cached node never starts, last-run.json is read only once a node settles, and a tool's debug commands are not part of the log", async () => {
    const { fs, rec, failed, markdown } = await play();

    assert.deepEqual(
      {
        log: rec.log,
        annotations: rec.annotations,
        checks: rec.checks,
        failed,
        lastRun: JSON.parse(await fs.readText("/cas/last-run.json")),
      },
      {
        log: [
          "▷ a",
          { title: "✔\uFE0E a (1.0s)", lines: ["ok line 1", "warned", "ok line 2"] },
          { title: "✔\uFE0E b (cached)", lines: ["from an earlier run"] },
          "▷ c (last run 3.0s)",
          { title: "✖\uFE0E c (1.0s)", lines: ["boom", "── error ──", "exit 1", "last line"] },
          "⏭\uFE0E d: skipped, dependency c failed",
          "",
          "dagactions · ✖\uFE0E c failed · built 1 · cached 1 · failed 1 · skipped 1 · wall 5.0s",
          "failed: c",
          "skipped, dependency failed: d",
          "reproduce: npx dagactions run ci.ts --only c",
        ],
        annotations: [{ level: "error", title: "c", message: "exit 1\nlast line" }],
        checks: [
          { name: "a", status: "in_progress", startedAt: "1970-01-01T00:16:40.000Z" },
          { name: "c", status: "in_progress", startedAt: "1970-01-01T00:16:44.000Z" },
          {
            name: "a",
            status: "completed",
            conclusion: "success",
            startedAt: "1970-01-01T00:16:40.000Z",
            completedAt: "1970-01-01T00:16:41.000Z",
            summary: "done in 1.0s",
            details: "```text\nok line 1\nwarned\nok line 2\n```",
          },
          {
            name: "b",
            status: "completed",
            conclusion: "success",
            startedAt: "1970-01-01T00:16:42.000Z",
            completedAt: "1970-01-01T00:16:43.000Z",
            summary: "cached",
            details: "```text\nfrom an earlier run\n```",
          },
          {
            name: "c",
            status: "completed",
            conclusion: "failure",
            startedAt: "1970-01-01T00:16:44.000Z",
            completedAt: "1970-01-01T00:16:45.000Z",
            summary: "exit 1\nlast line",
            details: "```text\nboom\n── error ──\nexit 1\nlast line\n```",
          },
          {
            name: "d",
            status: "completed",
            conclusion: "skipped",
            completedAt: "1970-01-01T00:16:46.000Z",
            summary: "dependency c failed",
          },
        ],
        failed: 2,
        lastRun: { durations: { a: 1000, b: 2000, c: 1000 } },
      },
    );

    assert.deepEqual(
      markdown,
      [
        "## dagactions",
        "",
        "### ✖\uFE0E c failed",
        "",
        "built **1** · cached **1** · failed **1** · skipped **1** · wall 5.0s · parallelism 0.4× · cache 1/2 hits, 2.0s saved",
        "",
        "```mermaid",
        "gantt",
        "  title node timeline",
        "  dateFormat x",
        "  axisFormat %M:%S",
        "  section nodes",
        "  a :done, 1000000, 1001000",
        "  c :crit, 1004000, 1005000",
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
      ...renderDag({ ...r, nodes: r.nodes.filter((n) => n.name !== "a") }),
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
            title: "dagactions summary",
            message: "broken failed: no coverage file",
          },
        ],
        markdown: [
          "## dagactions",
          "",
          "| node | status | duration | vs last |",
          "| --- | --- | --- | --- |",
          "| a | done | 1.0s | +100% |",
          "| b | cached | 1.0s |  |",
          "| c | fail | 1.0s |  |",
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
          "built **1** · cached **1** · failed **1** · skipped **1** · wall 5.0s · parallelism 0.4× · cache 1/2 hits, 2.0s saved",
          "",
        ].join("\n"),
      },
    );
  });
});
