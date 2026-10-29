import type { Node, Result } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { recapLines } from "./github/renderer.ts";
import type { NodeReport } from "./kernel/report.ts";
import {
  dagMermaid,
  renderCriticalPath,
  renderFailures,
  renderStatus,
  renderSummary,
  type RunReport,
} from "./summary.ts";

const node = (name: string, kind: string, deps: string[] = []): Node => ({ name, kind, deps });

/** A result as the engine gives one, `elapsed` for an action that ran. */
function resultOf(name: string, status: Result["status"], elapsed?: number): Result {
  const entry = { outputs: {}, contentHash: "h", outputHashes: {} };
  switch (status) {
    case "done":
      return { name, actionKey: "k", status, ...entry, elapsed: elapsed ?? 1 };
    case "cached":
      return { name, actionKey: "k", status, ...entry };
    case "failed":
      return {
        name,
        actionKey: "k",
        status,
        error: { name: "Error", message: "failed" },
        ...(elapsed !== undefined && { elapsed }),
      };
    case "dep-failed":
      return { name, actionKey: "", status, dep: "a" };
    case "cancelled":
      return { name, actionKey: "", status };
  }
}

/** A settled node; `ran` is [start, duration] for one whose action ran or that hit the cache. */
const settled = (
  name: string,
  status: Result["status"],
  ran?: [number, number],
  deps: string[] = [],
): NodeReport => ({
  node: node(name, name, deps),
  result: resultOf(name, status, status === "cached" ? undefined : ran?.[1]),
  ...(ran && { start: ran[0], duration: ran[1] }),
});

describe("summary", () => {
  test("each node shows its full name, a colon boxing nothing, and a huge graph collapses to one node per kind", () => {
    const scoped = [
      node("gw:build", "build"),
      node("gw:image", "image", ["gw:build"]),
      node("require-all", "require-all", ["gw:image"]),
    ];
    const statuses: Record<string, Result["status"]> = {
      "gw:build": "cached",
      "gw:image": "done",
      "require-all": "done",
    };
    const big = Array.from({ length: 70 }, (_, i) =>
      node(`t${i}`, i % 2 ? "test" : "build", i % 2 ? [`t${i - 1}`] : []),
    );
    assert.deepEqual(
      {
        scoped: dagMermaid(scoped, (n) => statuses[n]),
        big: dagMermaid(big, (n) => (n === "t1" ? "failed" : "done")),
      },
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
          "  classDef done fill:#dcfce7,stroke:#16a34a,color:#14532d",
          "  classDef cached fill:#f1f5f9,stroke:#94a3b8,color:#475569",
          "  classDef fail fill:#fee2e2,stroke:#dc2626,color:#7f1d1d",
          "  classDef skipped fill:#f8fafc,stroke:#cbd5e1,stroke-dasharray:4 4,color:#94a3b8",
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
      },
    );
  });

  test("over the budget, logs go first, then the blocks that no longer fit, counting UTF-8 bytes", async () => {
    const report: RunReport = { nodes: [], log: async () => [] };
    // 300 bytes in 100 UTF-16 units: the whole summary is 414 bytes but 214 units.
    const ticks = () => ["✓".repeat(100)];
    const log = () => ["```text", "x".repeat(50), "```"];
    const tail = () => ["c".repeat(40)];
    const render = (budget: number) =>
      renderSummary("t", report, [ticks, log, tail], () => {}, budget);
    assert.deepEqual(
      { logsDropped: await render(400), sectionDropped: await render(200) },
      {
        logsDropped:
          [
            "## t",
            "✓".repeat(100),
            "_(log omitted: summary over the 1 MiB budget)_",
            "c".repeat(40),
          ].join("\n\n") + "\n",
        sectionDropped:
          [
            "## t",
            "_(ticks omitted: summary over the 1 MiB budget)_",
            "_(log omitted: summary over the 1 MiB budget)_",
            "c".repeat(40),
          ].join("\n\n") + "\n",
      },
    );
  });

  test("the headline, the failures and the recap name every failure, requireAll beside what it requires", async () => {
    const nodes = [
      settled("restore:cas", "cached", [0, 5]),
      settled("test:unit", "failed", [10, 3000], ["restore:cas"]),
      settled("lint", "done", [10, 2000], ["restore:cas"]),
      settled("require-all", "failed", [3010, 3], ["test:unit", "lint"]),
      settled("deploy", "dep-failed", undefined, ["require-all"]),
    ];
    const logs: Record<string, string[]> = {
      "test:unit": ["expected 2, got 3", "── error ──", "bun test exited 1"],
      "require-all": ["── error ──", "failed: test:unit"],
    };
    const report: RunReport = { nodes, log: async (name) => logs[name] ?? [] };
    assert.deepEqual(
      {
        status: renderStatus(report),
        failures: await renderFailures(report),
        footer: recapLines("ci.ts", nodes, "npx --no dag run ci.ts"),
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
          "```text",
          "expected 2, got 3",
          "── error ──",
          "bun test exited 1",
          "```",
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
        footer: [
          "✖\uFE0E test:unit, require-all failed · ci.ts · built 1 · cached 1 · failed 2 · skipped 1 · wall 3.0s",
          "failed: test:unit, require-all",
          "skipped, dependency failed: deploy",
          "reproduce: npx --no dag run ci.ts --only test:unit,require-all",
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
            settled("build", "done", [8, 2000], ["restore"]),
            settled("check", "done", [2008, 5], ["build"]),
            settled("test", "done", [2013, 3000], ["check"]),
          ]),
        ),
        allBelow: renderCriticalPath(
          report([
            settled("restore", "cached", [0, 8]),
            settled("require-all", "done", [8, 50], ["restore"]),
          ]),
        ),
      },
      { mixed: ["critical path: build → test (5.0s)"], allBelow: [] },
    );
  });
});
