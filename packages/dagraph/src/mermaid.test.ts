import { describe, expect, test } from "bun:test";
import type { Node } from "./graph/index.ts";
import { mermaidBody } from "./mermaid.ts";

const node = (name: string, deps: string[] = []): Node => ({ name, kind: name, deps, config: "" });

describe("mermaidBody", () => {
  test("labels that mermaid would read as entities, tags or markdown, and an empty one, still parse", () => {
    const { lines } = mermaidBody([
      node('say "hi"'),
      node("a<b>c", ['say "hi"']),
      node("#35; issue"),
      node("`code`"),
      node("scope:"),
    ]);
    expect(lines).toEqual([
      '  n0["say #34;hi#34;"]',
      '  n1["a#60;b#62;c"]',
      '  n2["#35;35; issue"]',
      '  n3["#96;code#96;"]',
      '  subgraph s0 ["scope"]',
      '    n4[" "]',
      "  end",
      "  n0 --> n1",
    ]);
  });
});
