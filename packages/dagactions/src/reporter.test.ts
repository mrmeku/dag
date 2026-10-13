import type { ExecEvent, ExecResult, Node } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createTestPorts, steppingClock } from "./ports/memory.ts";
import { createReporter, dagMermaid } from "./reporter.ts";

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

describe("reporter", () => {
  test("live checks, groups with CAS logs, annotations, and the full summary", async () => {
    const { ports, fs, rec } = createTestPorts({
      files: {
        "/cas/k1/out/stdout.log": "ok line 1\nok line 2\n",
        "/cas/k1/out/stderr.log": "warned\n",
        "/cas/k2/out/stdout.log": "from an earlier run\n",
        "/cas/k3/out/stderr.log": "boom\n",
        "/cas/last-run.json": JSON.stringify({ durations: { a: 500, b: 2000 } }),
      },
      clock: steppingClock(1_000_000, 1000),
    });
    const reporter = createReporter(ports, { casBaseDir: CAS, nodes: NODES });

    const [a, b, c, d] = NODES as [Node, Node, Node, Node];
    const events: ExecEvent[] = [
      { type: "dispatch", node: a },
      { type: "start", node: a },
      { type: "done", node: a, actionKey: "k1", outputs: "x", contentHash: "h", elapsed: 400 },
      { type: "settled", node: a },
      { type: "dispatch", node: b },
      { type: "cached", node: b, actionKey: "k2", outputs: "y", contentHash: "h" },
      { type: "settled", node: b },
      { type: "dispatch", node: c },
      { type: "start", node: c },
      {
        type: "fail",
        node: c,
        actionKey: "k3",
        error: new Error("exit 1\nlast line"),
        elapsed: 50,
      },
      { type: "settled", node: c },
      { type: "dep-failed", node: d, error: new Error("dependency c failed") },
      { type: "settled", node: d },
    ];
    for (const ev of events) reporter.onEvent(ev);

    const results: ExecResult[] = [
      { name: "a", actionKey: "k1", status: "done", outputs: "x", contentHash: "h" },
      { name: "b", actionKey: "k2", status: "cached", outputs: "y", contentHash: "h" },
      { name: "c", actionKey: "k3", status: "fail", error: new Error("exit 1\nlast line") },
      { name: "d", actionKey: "", status: "dep-failed", error: new Error("dependency c failed") },
    ];
    const { failed, markdown } = await reporter.finish(results);

    assert.deepEqual(
      {
        groups: rec.groups,
        annotations: rec.annotations,
        checks: rec.checks,
        failed,
        lastRun: JSON.parse(await fs.readText("/cas/last-run.json")),
      },
      {
        groups: [
          { title: "✓ a (1.0s)", lines: ["ok line 1", "ok line 2", "── stderr ──", "warned"] },
          { title: "⚡ b (cached)", lines: ["from an earlier run"] },
          {
            title: "✗ c (1.0s)",
            lines: ["── stderr ──", "boom", "── error ──", "exit 1", "last line"],
          },
          { title: "⊘ d (dependency failed)", lines: ["dependency c failed"] },
        ],
        annotations: [{ level: "error", title: "c", message: "exit 1\nlast line" }],
        checks: [
          { name: "a", status: "in_progress", startedAt: "1970-01-01T00:16:40.000Z" },
          {
            name: "a",
            status: "completed",
            conclusion: "success",
            startedAt: "1970-01-01T00:16:40.000Z",
            completedAt: "1970-01-01T00:16:41.000Z",
            summary: "done in 1.0s",
            details: "```text\nok line 1\nok line 2\n── stderr ──\nwarned\n```",
          },
          { name: "b", status: "in_progress", startedAt: "1970-01-01T00:16:42.000Z" },
          {
            name: "b",
            status: "completed",
            conclusion: "success",
            startedAt: "1970-01-01T00:16:42.000Z",
            completedAt: "1970-01-01T00:16:43.000Z",
            summary: "cached",
            details: "```text\nfrom an earlier run\n```",
          },
          { name: "c", status: "in_progress", startedAt: "1970-01-01T00:16:44.000Z" },
          {
            name: "c",
            status: "completed",
            conclusion: "failure",
            startedAt: "1970-01-01T00:16:44.000Z",
            completedAt: "1970-01-01T00:16:45.000Z",
            summary: "exit 1\nlast line",
            details: "```text\n── stderr ──\nboom\n── error ──\nexit 1\nlast line\n```",
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
        "built **1** · cached **1** · failed **1** · skipped **1** · wall 5.0s · parallelism 0.4× · cache 1/2 hits, 2.0s saved",
        "",
        "critical path: a → c (2.0s)",
        "",
        "```mermaid",
        "flowchart LR",
        '  n0["✓ a"]',
        '  n1["⚡ b"]',
        '  n2["✗ c"]',
        '  n3["⊘ d"]',
        "  n0 --> n2",
        "  n2 -.-> n3",
        "  class n0 done",
        "  class n1 cached",
        "  class n2 fail",
        "  class n3 skipped",
        "  classDef done fill:#dcfce7,stroke:#16a34a,color:#14532d",
        "  classDef cached fill:#f1f5f9,stroke:#94a3b8,color:#475569",
        "  classDef fail fill:#fee2e2,stroke:#dc2626,color:#7f1d1d",
        "  classDef skipped fill:#f8fafc,stroke:#cbd5e1,stroke-dasharray:4 4,color:#94a3b8",
        "```",
        "",
        "### failures",
        "",
        "<details><summary>✗ c (1.0s)</summary>",
        "",
        "```text",
        "── stderr ──",
        "boom",
        "── error ──",
        "exit 1",
        "last line",
        "```",
        "",
        "</details>",
        "",
        "- ⊘ d: skipped, dependency failed",
        "",
        "| node | status | duration | vs last |",
        "| --- | --- | --- | --- |",
        "| a | done | 1.0s | +100% |",
        "| b | cached | 1.0s |  |",
        "| c | fail | 1.0s |  |",
        "| d | dep-failed |  |  |",
        "",
        "```mermaid",
        "gantt",
        "  title node timeline",
        "  dateFormat x",
        "  axisFormat %M:%S",
        "  section nodes",
        "  a :active, 1000000, 1001000",
        "  c :crit, 1004000, 1005000",
        "```",
        "",
      ].join("\n"),
    );
  });

  test("scoped names become subgraphs and a huge graph collapses to one node per kind", () => {
    const scoped = [
      node("gw:build", "build"),
      node("gw:image", "image", ["gw:build"]),
      node("gate", "gate", ["gw:image"]),
    ];
    const statuses: Record<string, ExecResult["status"]> = {
      "gw:build": "cached",
      "gw:image": "done",
      gate: "done",
    };
    const big = Array.from({ length: 70 }, (_, i) =>
      node(`t${i}`, i % 2 ? "test" : "build", i % 2 ? [`t${i - 1}`] : []),
    );
    assert.deepEqual(
      {
        scoped: dagMermaid(scoped, (n) => statuses[n]),
        big: dagMermaid(big, (n) => (n === "t1" ? "fail" : "done")),
      },
      {
        scoped: [
          "```mermaid",
          "flowchart LR",
          '  subgraph s0 ["gw"]',
          '    n0["⚡ build"]',
          '    n1["✓ image"]',
          "  end",
          '  n2["✓ gate"]',
          "  n0 --> n1",
          "  n1 --> n2",
          "  class n0 cached",
          "  class n1,n2 done",
          "  classDef done fill:#dcfce7,stroke:#16a34a,color:#14532d",
          "  classDef cached fill:#f1f5f9,stroke:#94a3b8,color:#475569",
          "  classDef fail fill:#fee2e2,stroke:#dc2626,color:#7f1d1d",
          "  classDef skipped fill:#f8fafc,stroke:#cbd5e1,stroke-dasharray:4 4,color:#94a3b8",
          "```",
        ],
        big: [
          "```mermaid",
          "flowchart LR",
          '  k0["build ×35: ✓35"]',
          '  k1["test ×35: ✓34 ✗1"]',
          "  k0 --> k1",
          "```",
        ],
      },
    );
  });
});
