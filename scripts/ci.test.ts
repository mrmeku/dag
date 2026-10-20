import { createTestPorts, type Ports } from "@mrmeku/dagactions";
import { Graph } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import ci from "./ci.ts";
import { processEach } from "./process-each.ts";

describe("ci workflow", () => {
  test("the CAS restore first, checks that order after it and read only their files, the CAS save on main only", async () => {
    const build = async (ref: string) => {
      const { ports } = createTestPorts({ context: { ref } });
      const graph = new Graph<Ports>();
      await ci.workflow(graph, ports, await ports.ci.context());
      return { nodes: graph.describe(), processed: await processEach(graph, ports) };
    };
    const { nodes, processed } = await build("refs/pull/7/merge");
    const onMain = (await build("refs/heads/main")).nodes;
    const by = (name: string) => nodes.find((n) => n.name === name)!;
    const reads = (name: string, file: string) => processed.get(name)!.files.includes(file);
    const checks = nodes.filter((n) => /^(typecheck|lint|test:)/.test(n.name));
    assert.deepEqual(
      {
        names: nodes.map((n) => n.name).sort(),
        onlyOnMain: onMain.map((n) => n.name).filter((n) => !by(n)),
        checksAfterRestore: checks.every((n) => n.deps.join() === "restore:cas"),
        typecheckReadsLintConfig: reads("typecheck", "eslint.config.ts"),
        engineTestsIgnoreRunner:
          reads("test:dagraph", "packages/dagraph/src/execute.ts") &&
          !reads("test:dagraph", "packages/dagactions/src/runner.ts"),
        runnerTestsReadThisFile: reads("test:dagactions", "scripts/ci.test.ts"),
        nobodyReadsReadme: nodes.every((n) => !reads(n.name, "README.md")),
        gateDeps: by("gate").deps.sort(),
        gateAllSettled: by("gate").settledDeps?.length,
        saveCas: onMain.find((n) => n.name === "save:cas")!.deps.sort(),
        uncached: nodes.filter((n) => n.cacheable === false).map((n) => n.name),
        limits: ci.limits,
      },
      {
        names: ["gate", "lint", "restore:cas", "test:dagactions", "test:dagraph", "typecheck"],
        onlyOnMain: ["save:cas"],
        checksAfterRestore: true,
        typecheckReadsLintConfig: true,
        engineTestsIgnoreRunner: true,
        runnerTestsReadThisFile: true,
        nobodyReadsReadme: true,
        gateDeps: ["lint", "test:dagactions", "test:dagraph", "typecheck"],
        gateAllSettled: 4,
        saveCas: ["gate", "restore:cas"],
        uncached: ["restore:cas"],
        limits: { maxParallelism: 4, concurrencyLimits: { test: 2 } },
      },
    );
  });
});
