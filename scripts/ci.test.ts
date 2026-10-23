import { Graph } from "@mrmeku/dagraph";
import { createTestPorts, createWorkflow, selectNodes, type Ports } from "@mrmeku/dagworkflows";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import ci from "./ci.ts";
import { processEach } from "./process-each.ts";

describe("ci workflow", () => {
  test("the CAS restore first, checks that order after it and read only their files, the CAS save on main only, after every check", async () => {
    const build = async (ref: string) => {
      const { ports } = createTestPorts({ context: { ref } });
      const graph = new Graph<Ports>();
      await createWorkflow(graph, ports, await ports.host.context()).compose(ci);
      // The graph a run executes, where the save waits for every node that reads the CAS.
      return { nodes: selectNodes(graph).describe(), processed: await processEach(graph, ports) };
    };
    const { nodes, processed } = await build("refs/pull/7/merge");
    const onMain = (await build("refs/heads/main")).nodes;
    const nodesByName = new Map(nodes.map((n) => [n.name, n]));
    const by = (name: string) => nodesByName.get(name);
    const reads = (name: string, file: string) => {
      const node = processed.get(name);
      assert.ok(node, `${name} was not processed`);
      return node.files.includes(file);
    };
    const checks = nodes.filter((n) => /^(typecheck|lint|test:)/.test(n.name));
    assert.deepEqual(
      {
        names: nodes.map((n) => n.name).sort(),
        onlyOnMain: onMain.map((n) => n.name).filter((n) => !by(n)),
        checksAfterRestore: checks.every((n) => n.deps.join() === "restore:cas"),
        typecheckReadsLintConfig: reads("typecheck", "eslint.config.ts"),
        engineTestsIgnoreRunner:
          reads("test:dagraph", "packages/dagraph/src/execute.ts") &&
          !reads("test:dagraph", "packages/dagworkflows/src/runner.ts"),
        runnerTestsReadThisFile: reads("test:dagworkflows", "scripts/ci.test.ts"),
        nobodyReadsReadme: nodes.every((n) => !reads(n.name, "README.md")),
        requireAllDeps: by("require-all")?.deps.sort(),
        requireAllSettledDeps: by("require-all")?.settledDeps?.length,
        saveCas: onMain.find((n) => n.name === "save:cas"),
        uncached: nodes.filter((n) => n.cacheable === false).map((n) => n.name),
        schedulerOptions: ci.schedulerOptions,
      },
      {
        names: [
          "lint",
          "require-all",
          "restore:cas",
          "test:dagraph",
          "test:dagworkflows",
          "typecheck",
        ],
        onlyOnMain: ["save:cas"],
        checksAfterRestore: true,
        typecheckReadsLintConfig: true,
        engineTestsIgnoreRunner: true,
        runnerTestsReadThisFile: true,
        nobodyReadsReadme: true,
        requireAllDeps: ["lint", "test:dagraph", "test:dagworkflows", "typecheck"],
        requireAllSettledDeps: 4,
        saveCas: {
          name: "save:cas",
          kind: "save:cas",
          deps: [
            "restore:cas",
            "typecheck",
            "lint",
            "test:dagraph",
            "test:dagworkflows",
            "require-all",
          ],
          settledDeps: ["typecheck", "lint", "test:dagraph", "test:dagworkflows", "require-all"],
          cacheable: false,
        },
        uncached: ["restore:cas"],
        schedulerOptions: { maxParallelism: 4, concurrencyLimits: { test: 2 } },
      },
    );
  });
});
