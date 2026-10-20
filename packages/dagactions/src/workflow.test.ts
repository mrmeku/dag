import { Graph } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Ports } from "./ports.ts";
import { createTestPorts } from "./ports/memory.ts";
import { defineWorkflow, type Steps } from "./workflow.ts";

describe("defineWorkflow", () => {
  test("binds the facade and carries limits; group names are checked against them", async () => {
    const def = defineWorkflow({
      limits: { concurrencyLimits: { heavy: 1 } },
      build: (w) => {
        const a = w.run({ name: "a", cmd: ["x"], group: "heavy" });
        // @ts-expect-error "light" is not a declared concurrency group
        const b = w.run({ name: "b", cmd: ["y"], group: "light", deps: { a } });
        // @ts-expect-error a post step says what it waits for; a graph has no end of job
        w.post({ name: "a:post", main: a, cmd: ["z"] });
        w.gate({ deps: { a, b } });
      },
    });
    const { ports } = createTestPorts();
    const graph = new Graph<Ports>();
    await def.workflow(graph, ports, await ports.ci.context());
    assert.deepEqual(
      {
        limits: def.limits,
        nodes: graph.describe().map((n) => [n.name, n.deps, n.concurrencyGroup ?? null]),
      },
      {
        limits: { concurrencyLimits: { heavy: 1 } },
        nodes: [
          ["a", [], "heavy"],
          ["b", ["a"], "light"],
          ["a:post", ["a"], null],
          ["gate", ["a", "b"], null],
        ],
      },
    );
  });

  // Checked by the typecheck: a call that does not compile fails it, as the @ts-expect-error does
  // if the call compiles. Building the graphs would repeat what the test above asserts.
  test("a builder typed Steps takes the facade of any workflow; one that uses a group takes only a workflow that declares it", () => {
    const lint = (w: Steps) => w.run({ name: "lint", cmd: ["lint"] });
    const compile = (w: Steps<"mix">) => w.run({ name: "compile", cmd: ["mix"], group: "mix" });
    defineWorkflow({ build: (w) => void lint(w) });
    defineWorkflow({
      limits: { concurrencyLimits: { mix: 1, browser: 1 } },
      build: (w) => void [lint(w), compile(w)],
    });
    // @ts-expect-error a builder that uses a group the workflow does not declare
    defineWorkflow({ limits: { concurrencyLimits: { browser: 1 } }, build: (w) => compile(w) });
  });
});
