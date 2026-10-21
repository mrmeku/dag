import type { ExecEvent, Node, Result } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { STATUS_ICON } from "./config.ts";
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

const RESULTS: [Result, Result, Result, Result] = [
  { name: "a", actionKey: "k1", status: "done", outputs: "x", contentHash: "h", elapsed: 400 },
  { name: "b", actionKey: "k2", status: "cached", outputs: "y", contentHash: "h" },
  {
    name: "c",
    actionKey: "k3",
    status: "failed",
    error: { name: "Error", message: "exit 1\nlast line" },
    elapsed: 50,
  },
  { name: "d", actionKey: "", status: "dep-failed", dep: "c" },
];
const [A, B, C, D] = RESULTS;
const settled = (result: Result): ExecEvent => ({ type: "result", node: result.name, result });
const EVENTS: ExecEvent[] = [
  { type: "dispatch", node: "a" },
  { type: "start", node: "a" },
  settled(A),
  { type: "dispatch", node: "b" },
  settled(B),
  { type: "dispatch", node: "c" },
  { type: "start", node: "c" },
  settled(C),
  settled(D),
];

/** a built, b cached, c failed with logs in the CAS, d skipped; a and b ran before. */
async function play(summary?: readonly SummaryRenderer[]) {
  const { ports, fs, rec } = createTestPorts({
    files: {
      "/cas.logs/k1.log": "ok line 1\nwarned\nok line 2\n",
      "/cas.logs/k2.log": "from an earlier run\n",
      "/cas.logs/k3.log": "::debug::walking\nboom\n",
      "/cas/last-run.json": JSON.stringify({ durations: { a: 500, b: 2000, c: 3000 } }),
    },
    clock: steppingClock(1_000_000, 1000),
  });
  const reporter = createReporter(ports, {
    casBaseDir: CAS,
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
    const { ports, rec } = createTestPorts({
      files: { "/cas.logs/k2.log": "partial\n" },
    });
    const slow = { ...node("slow", "test"), timeoutMs: 900_000 };
    const half = { ...node("half", "test"), timeoutMs: 90_000 };
    const reporter = createReporter(ports, { casBaseDir: CAS, nodes: [slow, half] });
    const timedOut = (name: string, actionKey: string): Result => {
      const error = { name: "TimeoutError", message: "timed out" };
      return { name, actionKey, status: "failed", error, elapsed: 1 };
    };
    const results = [timedOut("slow", "k2"), timedOut("half", "")];
    const events: ExecEvent[] = results.flatMap((result) => [
      { type: "dispatch", node: result.name },
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

  test("start lines, live checks, groups with CAS logs, plain lines for what did not run, annotations, the default summary and the closing recap; a cached node never starts, last-run.json is read only once a node settles, and a tool's debug commands are not part of the log", async () => {
    const { fs, rec, failed, markdown } = await play();

    assert.deepEqual(
      {
        log: rec.log,
        annotations: rec.annotations,
        checks: rec.checks,
        failed,
        lastRun: await parsed(fs.readText("/cas/last-run.json")),
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
        lastRun: { durations: { a: 1000, b: 2000, c: 1000 } },
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
