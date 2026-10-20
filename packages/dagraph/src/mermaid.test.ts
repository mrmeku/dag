import { describe, expect, test } from "bun:test";
import type { Node } from "./graph/index.ts";
import { mermaidBody } from "./mermaid.ts";

const node = (
  name: string,
  extra: Partial<Node<{ video: string }>> = {},
): Node<{ video: string }> => ({
  name,
  kind: name,
  deps: [],
  ...extra,
});

describe("mermaidBody", () => {
  test("labels that mermaid would read as entities, tags or markdown, and an empty one, still parse", () => {
    const { lines } = mermaidBody([
      node('say "hi"'),
      node("a<b>c", { deps: ['say "hi"'] }),
      node("#35; issue"),
      node("`code`"),
      node(""),
    ]);
    expect(lines).toEqual([
      '  n0["say #34;hi#34;"]',
      '  n1["a#60;b#62;c"]',
      '  n2["#35;35; issue"]',
      '  n3["#96;code#96;"]',
      '  n4[" "]',
      "  n0 --> n1",
    ]);
  });

  test("boxes nodes by a function of their meta, under their full names, with settled deps dashed", () => {
    const nodes = [
      node("feed", { deps: [] }),
      node("v1:download", { meta: { video: "v1" } }),
      node("v1:captions", { meta: { video: "v1" }, deps: ["v1:download"] }),
      node("v1:entry", {
        meta: { video: "v1" },
        deps: ["v1:download", "v1:captions"],
        settledDeps: ["v1:captions"],
      }),
    ];
    expect({
      boxed: mermaidBody(nodes, { subgraphOf: (meta) => meta?.video ?? "" }).lines,
      unboxed: mermaidBody(nodes.slice(0, 2)).lines,
    }).toEqual({
      boxed: [
        '  n0["feed"]',
        '  subgraph s0 ["v1"]',
        '    n1["v1:download"]',
        '    n2["v1:captions"]',
        '    n3["v1:entry"]',
        "  end",
        "  n1 --> n2",
        "  n1 --> n3",
        "  n2 -.-> n3",
      ],
      unboxed: ['  n0["feed"]', '  n1["v1:download"]'],
    });
  });
});
