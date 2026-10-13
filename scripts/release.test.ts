import { createTestPorts } from "@mrmeku/dagactions";
import { Graph, type Node } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import release from "./release.ts";

const cmdOf = (n: Node) => (JSON.parse(n.config) as { cmd: unknown[] }).cmd;

describe("release workflow", () => {
  test("a tag releases its version, any other ref dry-runs; packs are outputs, publishes are receipts after the gate, the engine before the runner", async () => {
    const build = async (ref: string) => {
      const { ports } = createTestPorts({ context: { ref, sha: "abc1234def" } });
      const graph = new Graph();
      const out = await release.workflow(graph, ports, await ports.ci.context());
      return { nodes: graph.describe(), ...out };
    };
    const tagged = await build("refs/tags/v1.2.3");
    const branch = await build("refs/heads/main");
    const by = (name: string) => tagged.nodes.find((n) => n.name === name)!;
    assert.deepEqual(
      {
        versions: [tagged.version, tagged.dryRun, branch.version, branch.dryRun],
        names: tagged.nodes.map((n) => n.name).sort(),
        restoreConfig: JSON.parse(by("restore:cas").config),
        packCmd: cmdOf(by("pack:dagraph")),
        packOutputs: (JSON.parse(by("pack:dagactions").config) as { outputs: unknown }).outputs,
        packInputs: by("pack:dagactions").inputs?.some(
          (f) => f === "packages/dagactions/package.json",
        ),
        publishCmd: cmdOf(by("publish:dagraph")),
        dryRunPublishCmd: cmdOf(branch.nodes.find((n) => n.name === "publish:dagraph")!),
        publishDaghaDeps: by("publish:dagactions").deps.sort(),
        publishDagraphDeps: by("publish:dagraph").deps.sort(),
        actionCmd: cmdOf(by("release:action")),
        actionDeps: by("release:action").deps.sort(),
        releaseDeps: by("release").deps.sort(),
        saveDeps: { deps: by("save:cas").deps.sort(), optional: by("save:cas").optionalDeps },
        uncached: tagged.nodes.filter((n) => n.cacheable === false).map((n) => n.name),
        checksAfterRestore: tagged.nodes
          .filter((n) => /^(typecheck|lint|test:)/.test(n.name))
          .every((n) => n.deps.join() === "restore:cas"),
      },
      {
        versions: ["1.2.3", false, "0.0.0-dev.abc1234", true],
        names: [
          "build:action",
          "gate",
          "lint",
          "pack:dagactions",
          "pack:dagraph",
          "publish:dagactions",
          "publish:dagraph",
          "release",
          "release:action",
          "restore:cas",
          "save:cas",
          "test:dagactions",
          "test:dagraph",
          "typecheck",
        ],
        restoreConfig: {
          v: 1,
          path: [".dagactions/cas"],
          key: "dagactions-release-1.2.3-abc1234def",
          restoreKeys: ["dagactions-release-1.2.3-", "dagactions-main-"],
        },
        packCmd: ["bun", "scripts/pack.ts", "dagraph", "1.2.3", "$DAGACTIONS_OUT"],
        packOutputs: { tarball: "mrmeku-dagactions-1.2.3.tgz" },
        packInputs: true,
        publishCmd: [
          "npm",
          "publish",
          { node: "pack:dagraph", output: "tarball" },
          "--access",
          "public",
        ],
        dryRunPublishCmd: [
          "npm",
          "publish",
          { node: "pack:dagraph", output: "tarball" },
          "--access",
          "public",
          "--tag",
          "next",
          "--dry-run",
        ],
        publishDaghaDeps: ["gate", "pack:dagactions", "publish:dagraph"],
        publishDagraphDeps: ["gate", "pack:dagraph"],
        actionCmd: [
          "bun",
          "scripts/release-action.ts",
          "1.2.3",
          { node: "build:action", output: "main" },
          { node: "build:action", output: "post" },
        ],
        actionDeps: ["build:action", "gate"],
        releaseDeps: ["publish:dagactions", "publish:dagraph", "release:action"],
        saveDeps: { deps: ["release", "restore:cas"], optional: ["release"] },
        uncached: ["restore:cas", "save:cas"],
        checksAfterRestore: true,
      },
    );
  });
});
