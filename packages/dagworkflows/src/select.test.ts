import { Graph } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addCommand } from "./commands.ts";
import type { Ports } from "./ports.ts";
import { selectNodes } from "./select.ts";

describe("selectNodes", () => {
  test("keeps the requested nodes and their transitive deps only", () => {
    const graph = new Graph<Ports>();
    const a = addCommand(graph, { name: "a", cmd: ["a"] });
    const b = addCommand(graph, { name: "b", cmd: ["b"], deps: { a } });
    addCommand(graph, { name: "c", cmd: ["c"], deps: { b } });
    addCommand(graph, { name: "d", cmd: ["d"], deps: { a } });
    addCommand(graph, { name: "e", cmd: ["e"] });
    assert.deepEqual(
      selectNodes(graph, ["c"])
        .describe()
        .map((node) => node.name),
      ["a", "b", "c"],
    );
  });
});
