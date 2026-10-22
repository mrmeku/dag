import { Graph } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { run } from "./commands.ts";
import type { Ports } from "./ports.ts";
import { selectNodes } from "./select.ts";

describe("selectNodes", () => {
  test("keeps the requested nodes and their transitive deps only", () => {
    const graph = new Graph<Ports>();
    const a = run(graph, { name: "a", cmd: ["a"] });
    const b = run(graph, { name: "b", cmd: ["b"], deps: { a } });
    run(graph, { name: "c", cmd: ["c"], deps: { b } });
    run(graph, { name: "d", cmd: ["d"], deps: { a } });
    run(graph, { name: "e", cmd: ["e"] });
    assert.deepEqual(
      selectNodes(graph, ["c"])
        .describe()
        .map((node) => node.name),
      ["a", "b", "c"],
    );
  });
});
