import type { Node, NodeResult } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { NodeReport } from "../kernel/index.ts";
import type { RunReport } from "../run-store/index.ts";
import {
  renderCriticalPath,
  renderDag,
  renderFailures,
  renderStatus,
  renderTable,
  renderTimeline,
} from "./index.ts";

const node = (name: string, kind: string, deps: string[] = []): Node => ({ name, kind, deps });

/** How a fixture's node settled: built or cached, or a status other than success. */
type Outcome = "built" | "cached" | Exclude<NodeResult["status"], "succeeded">;

/** A result as the engine gives one, `elapsed` for an action that ran. */
function resultOf(name: string, outcome: Outcome, elapsed?: number): NodeResult {
  const entry = { outputs: {}, contentHash: "h", outputHashes: {} };
  switch (outcome) {
    case "built":
      return {
        name,
        status: "succeeded",
        details: { actionKey: "k", entry, actionRan: true, elapsed: elapsed ?? 1 },
      };
    case "cached":
      return { name, status: "succeeded", details: { actionKey: "k", entry, actionRan: false } };
    case "failed":
      return {
        name,
        status: outcome,
        error: { name: "Error", message: "failed" },
        details: { actionKey: "k", ...(elapsed !== undefined && { elapsed }) },
      };
    case "dep-failed":
      return { name, status: outcome, dep: "a" };
    case "cancelled":
      return { name, status: outcome };
  }
}

/** A settled node; `ran` is [start, duration] for one whose action ran or that hit the cache. */
const settled = (
  name: string,
  outcome: Outcome,
  ran?: [number, number],
  deps: string[] = [],
): NodeReport => ({
  node: node(name, name, deps),
  result: resultOf(name, outcome, outcome === "cached" ? undefined : ran?.[1]),
  ...(ran && { start: ran[0], duration: ran[1] }),
});

const reportOf = (nodes: NodeReport[]): RunReport => ({ nodes, log: async () => [] });
const CLASSDEFS = [
  "  classDef done fill:#dcfce7,stroke:#16a34a,color:#14532d",
  "  classDef cached fill:#f1f5f9,stroke:#94a3b8,color:#475569",
  "  classDef fail fill:#fee2e2,stroke:#dc2626,color:#7f1d1d",
  "  classDef skipped fill:#f8fafc,stroke:#cbd5e1,stroke-dasharray:4 4,color:#94a3b8",
];

describe("summary renderers", () => {
  test("each node shows its full name, a colon boxing nothing, and a huge graph collapses to one node per kind", () => {
    const scoped = reportOf([
      settled("gw:build", "cached", [0, 5]),
      settled("gw:image", "built", [5, 10], ["gw:build"]),
      settled("require-all", "built", [15, 1], ["gw:image"]),
    ]);
    const big = reportOf(
      Array.from({ length: 70 }, (_, i) => ({
        node: node(`t${i}`, i % 2 ? "test" : "build", i % 2 ? [`t${i - 1}`] : []),
        result: resultOf(`t${i}`, i === 1 ? "failed" : i === 0 ? "cached" : "built"),
      })),
    );
    // Drawn without `gw:build`, as a workflow's own renderer may: the edge from it goes too.
    const filtered = reportOf(scoped.nodes.slice(1));
    assert.deepEqual(
      { scoped: renderDag(scoped), big: renderDag(big), filtered: renderDag(filtered) },
      {
        scoped: [
          "```mermaid",
          "flowchart LR",
          '  n0["✔\uFE0E gw:build"]',
          '  n1["✔\uFE0E gw:image"]',
          '  n2["✔\uFE0E require-all"]',
          "  n0 --> n1",
          "  n1 --> n2",
          "  class n0 cached",
          "  class n1,n2 done",
          ...CLASSDEFS,
          "```",
        ],
        big: [
          "```mermaid",
          "flowchart LR",
          '  k0["build ×35: ✔\uFE0E35"]',
          '  k1["test ×35: ✔\uFE0E34 ✖\uFE0E1"]',
          "  k0 --> k1",
          "```",
        ],
        filtered: [
          "```mermaid",
          "flowchart LR",
          '  n0["✔\uFE0E gw:image"]',
          '  n1["✔\uFE0E require-all"]',
          "  n0 --> n1",
          "  class n0,n1 done",
          ...CLASSDEFS,
          "```",
        ],
      },
    );
  });

  test("the headline and the failures name every failure, requireAll beside what it requires, and a log holding a fence gets a longer one", async () => {
    const nodes = [
      settled("restore:cache-dir", "cached", [0, 5]),
      settled("test:unit", "failed", [10, 3000], ["restore:cache-dir"]),
      settled("lint", "built", [10, 2000], ["restore:cache-dir"]),
      settled("require-all", "failed", [3010, 3], ["test:unit", "lint"]),
      settled("deploy", "dep-failed", undefined, ["require-all"]),
    ];
    const logs: Record<string, string[]> = {
      // A snapshot diff's context line, which a fence of three would end.
      "test:unit": ["expected 2, got 3", "  ```", "── error ──", "bun test exited 1"],
      "require-all": ["── error ──", "failed: test:unit"],
    };
    const report: RunReport = { nodes, log: async (name) => logs[name] ?? [] };
    assert.deepEqual(
      {
        status: renderStatus(report),
        failures: await renderFailures(report),
      },
      {
        status: [
          "### ✖\uFE0E test:unit, require-all failed",
          "",
          "built **1** · cached **1** · failed **2** · skipped **1** · wall 3.0s · parallelism 1.7× · cache 1/2 hits",
        ],
        failures: [
          "### failures",
          "",
          "<details><summary>✖\uFE0E test:unit (3.0s)</summary>",
          "",
          "````text",
          "expected 2, got 3",
          "  ```",
          "── error ──",
          "bun test exited 1",
          "````",
          "",
          "</details>",
          "",
          "<details><summary>✖\uFE0E require-all (3ms)</summary>",
          "",
          "```text",
          "── error ──",
          "failed: test:unit",
          "```",
          "",
          "</details>",
          "",
          "- ⏭\uFE0E deploy: skipped, dependency failed",
        ],
      },
    );
  });

  test("the critical path counts only nodes that took the floor or more, and is hidden when none did", () => {
    const report = (nodes: NodeReport[]): RunReport => ({ nodes, log: async () => [] });
    assert.deepEqual(
      {
        mixed: renderCriticalPath(
          report([
            settled("restore", "cached", [0, 8]),
            settled("build", "built", [8, 2000], ["restore"]),
            settled("check", "built", [2008, 5], ["build"]),
            settled("test", "built", [2013, 3000], ["check"]),
          ]),
        ),
        allBelow: renderCriticalPath(
          report([
            settled("restore", "cached", [0, 8]),
            settled("require-all", "built", [8, 50], ["restore"]),
          ]),
        ),
      },
      { mixed: ["critical path: build → test (5.0s)"], allBelow: [] },
    );
  });

  test("the timeline draws what ran to its end, the table compares a build with its last run, and the failures show a node's last 60 lines, one that never started, and what did not run", async () => {
    const nodes: NodeReport[] = [
      { ...settled("restore:cache-dir", "cached", [0, 5]), previous: 4000 },
      settled("hash", "failed"),
      { ...settled("lint", "built", [10, 2000], ["restore:cache-dir"]), previous: 1000 },
      settled("test:unit", "failed", [10, 3000], ["restore:cache-dir"]),
      {
        node: node("slow", "slow"),
        result: { name: "slow", status: "cancelled", details: { actionKey: "k", elapsed: 500 } },
        start: 20,
        duration: 500,
      },
      settled("deploy", "dep-failed", undefined, ["test:unit"]),
    ];
    const testLog = Array.from({ length: 61 }, (_, i) => `line ${i + 1}`);
    const logs: Record<string, string[]> = {
      hash: ["── error ──", "ENOENT: src/a.ts"],
      "test:unit": testLog,
    };
    const report: RunReport = { nodes, log: async (name) => logs[name] ?? [] };
    assert.deepEqual(
      {
        timeline: renderTimeline(report),
        table: renderTable(report),
        failures: await renderFailures(report),
      },
      {
        timeline: [
          "```mermaid",
          "gantt",
          "  title node timeline",
          "  dateFormat x",
          "  axisFormat %M:%S",
          "  section nodes",
          "  lint :done, 10, 2010",
          "  test/unit :crit, 10, 3010",
          "```",
        ],
        table: [
          "| node | status | duration | vs last |",
          "| --- | --- | --- | --- |",
          "| deploy | dep-failed |  |  |",
          "| hash | failed |  |  |",
          "| lint | done | 2.0s | +100% |",
          "| restore:cache-dir | cached | 5ms |  |",
          "| slow | cancelled | 500ms |  |",
          "| test:unit | failed | 3.0s |  |",
        ],
        failures: [
          "### failures",
          "",
          "<details><summary>✖\uFE0E hash (not started)</summary>",
          "",
          "```text",
          "── error ──",
          "ENOENT: src/a.ts",
          "```",
          "",
          "</details>",
          "",
          "<details><summary>✖\uFE0E test:unit (3.0s)</summary>",
          "",
          "```text",
          ...testLog.slice(1),
          "```",
          "",
          "</details>",
          "",
          "- ◼\uFE0E slow: cancelled",
          "- ⏭\uFE0E deploy: skipped, dependency failed",
        ],
      },
    );
  });
});
