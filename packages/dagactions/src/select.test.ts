import { Graph, type RunnableNode } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { selectNodes } from "./select.ts";

const node = (name: string, deps: string[] = []): RunnableNode => ({
  name,
  kind: name,
  deps,
  config: "",
  params: { kind: name },
  action: async () => "",
});

describe("selectNodes", () => {
  test("keeps the requested nodes and their transitive deps only", () => {
    const graph = new Graph();
    for (const n of [node("a"), node("b", ["a"]), node("c", ["b"]), node("d", ["a"]), node("e")])
      graph.add(n);
    assert.deepEqual([...selectNodes(graph, ["c"]).getNodes().keys()], ["a", "b", "c"]);
  });
});
