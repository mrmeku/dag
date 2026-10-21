import { Graph } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Ports } from "./ports.ts";
import { createTestPorts } from "./ports/memory.ts";
import { defineWorkflow, type Workflow } from "./workflow.ts";

describe("defineWorkflow", () => {
  test("binds the facade and carries scheduler options; group names are checked against them", async () => {
    const def = defineWorkflow({
      schedulerOptions: { concurrencyLimits: { heavy: 1 } },
      implementation: (workflow) => {
        const a = workflow.run({ name: "a", cmd: ["x"], group: "heavy" });
        // @ts-expect-error "light" is not a declared concurrency group
        const b = workflow.run({ name: "b", cmd: ["y"], group: "light", deps: { a } });
        // @ts-expect-error a post step says what it waits for; a graph has no end of job
        workflow.post({ name: "a:post", main: a, cmd: ["z"] });
        workflow.requireAll({ deps: { a, b } });
      },
    });
    const { ports } = createTestPorts();
    const graph = new Graph<Ports>();
    await def.implementation(graph, ports, await ports.host.context());
    assert.deepEqual(
      {
        schedulerOptions: def.schedulerOptions,
        nodes: graph.describe().map((n) => [n.name, n.deps, n.concurrencyGroup ?? null]),
      },
      {
        schedulerOptions: { concurrencyLimits: { heavy: 1 } },
        nodes: [
          ["a", [], "heavy"],
          ["b", ["a"], "light"],
          ["a:post", ["a"], null],
          ["require-all", ["a", "b"], null],
        ],
      },
    );
  });

  // Checked by the typecheck: a call that does not compile fails it, as the @ts-expect-error does
  // if the call compiles. Building the graphs would repeat what the test above asserts.
  test("a builder typed Workflow takes the facade of any workflow; one that uses a group takes only a workflow that declares it", () => {
    const lint = (workflow: Workflow) => workflow.run({ name: "lint", cmd: ["lint"] });
    const compile = (workflow: Workflow<"mix">) =>
      workflow.run({ name: "compile", cmd: ["mix"], group: "mix" });
    defineWorkflow({ implementation: (workflow) => void lint(workflow) });
    defineWorkflow({
      schedulerOptions: { concurrencyLimits: { mix: 1, browser: 1 } },
      implementation: (workflow) => void [lint(workflow), compile(workflow)],
    });
    defineWorkflow({
      schedulerOptions: { concurrencyLimits: { browser: 1 } },
      // @ts-expect-error a builder that uses a group the workflow does not declare
      implementation: (workflow) => compile(workflow),
    });
  });
});
