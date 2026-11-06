import { Graph } from "@mrmeku/dagraph";
import {
  createTestPorts,
  createWorkflow,
  nodejsRuntime,
  selectNodes,
  type Ports,
} from "@mrmeku/dagworkflows";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import ci from "./ci.ts";
import { fromDagDirectory, processEach } from "./process-each.ts";

describe("ci workflow", () => {
  test("the cache restore first, checks that order after it and read only their files, the cache save on main only, after every check", async () => {
    const build = async (ref: string) => {
      const { ports } = createTestPorts({ context: { ref } });
      // The checks' inputs are globbed from the real tree.
      ports.fileMatcher = nodejsRuntime.fileMatcher;
      const graph = new Graph<Ports>();
      const context = await ports.host.context();
      await fromDagDirectory(() => createWorkflow(graph, ports, context).compose(ci));
      // The graph a run executes, where the save waits for every node that reads the cache dir.
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
    const checks = nodes.filter(
      (n) => /^(typecheck|lint|test:)/.test(n.name) && n.name !== "test:e2e",
    );
    assert.deepEqual(
      {
        names: nodes.map((n) => n.name).sort(),
        onlyOnMain: onMain.map((n) => n.name).filter((n) => !by(n)),
        checksAfterRestore: checks.every((n) => n.deps.join() === "restore:cache"),
        typecheckReadsLintConfig: reads("typecheck", "eslint.config.ts"),
        engineTestsIgnoreRunner:
          reads("test:dagraph", "packages/dagraph/src/execute.ts") &&
          !reads("test:dagraph", "packages/dagworkflows/src/run/index.ts"),
        runnerTestsReadThisFile: reads("test:dagworkflows", "scripts/ci.test.ts"),
        nobodyReadsReadme: nodes.every((n) => !reads(n.name, "README.md")),
        endToEndDeps: by("test:e2e")?.deps.sort(),
        requireAllDeps: by("require-all")?.deps.sort(),
        requireAllSettledDeps: by("require-all")?.settledDeps?.length,
        saveCache: onMain.find((n) => n.name === "save:cache"),
        uncached: nodes.filter((n) => n.cacheable === false).map((n) => n.name),
        schedulerOptions: ci.schedulerOptions,
      },
      {
        names: [
          "build:action",
          "lint",
          "pack:dagraph",
          "pack:dagworkflows",
          "require-all",
          "restore:cache",
          "test:dagraph",
          "test:dagworkflows",
          "test:e2e",
          "typecheck",
        ],
        onlyOnMain: ["save:cache"],
        checksAfterRestore: true,
        typecheckReadsLintConfig: true,
        engineTestsIgnoreRunner: true,
        runnerTestsReadThisFile: true,
        nobodyReadsReadme: true,
        // The packed packages and the bundle exist before the end-to-end tests start.
        endToEndDeps: ["build:action", "pack:dagraph", "pack:dagworkflows"],
        requireAllDeps: [
          "lint",
          "pack:dagraph",
          "pack:dagworkflows",
          "test:dagraph",
          "test:dagworkflows",
          "test:e2e",
          "typecheck",
        ],
        requireAllSettledDeps: 7,
        saveCache: {
          name: "save:cache",
          kind: "save:cache",
          cacheable: false,
          deps: [
            "restore:cache",
            "pack:dagraph",
            "pack:dagworkflows",
            "build:action",
            "test:e2e",
            "typecheck",
            "lint",
            "test:dagraph",
            "test:dagworkflows",
            "require-all",
          ],
          settledDeps: [
            "restore:cache",
            "pack:dagraph",
            "pack:dagworkflows",
            "build:action",
            "test:e2e",
            "typecheck",
            "lint",
            "test:dagraph",
            "test:dagworkflows",
            "require-all",
          ],
        },
        uncached: ["restore:cache", "test:e2e"],
        schedulerOptions: { maxParallelism: 4, concurrencyLimits: { test: 2 } },
      },
    );
  });
});
