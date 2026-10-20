/**
 * Draws a graph as a Mermaid flowchart. Published as `@mrmeku/dagraph/mermaid`, beside the engine:
 * it reads only `graph.describe()`, so a team can copy and change it.
 */
import type { Node } from "./graph/index.ts";

export interface MermaidOptions<Meta = unknown> {
  /** Text inside a node's box. Default: its full name. */
  label?: (node: Node<Meta>) => string;
  /** The box a node is drawn in, from its `meta`; "" for none. Without it, nothing is boxed. */
  subgraphOf?: (meta: Meta | undefined) => string;
  /** Title of a box, given its subgraph and its index. Default: the subgraph itself. */
  subgraphLabel?: (subgraph: string, index: number) => string;
  /** A class name per node, applied with `class` lines. Default: none. */
  classOf?: (node: Node<Meta>) => string | undefined;
}

/**
 * A mermaid label as a quoted string. The characters mermaid would read as an entity, an HTML tag
 * or a markdown string (# " < > `) become numeric entity codes, and an empty label, which mermaid
 * refuses to parse, becomes a space.
 */
export function mermaidQuote(text: string): string {
  return `"${text.replace(/[#"<>`]/g, (c) => `#${c.charCodeAt(0)};`) || " "}"`;
}

/**
 * The body of a mermaid flowchart for a set of nodes: one box per node, each `subgraphOf` box as a
 * subgraph (ids `s0`, `s1`, …), one edge per dependency (dashed when settled), then `class` lines
 * grouping nodes by the class `classOf` gives them. Callers add the header (`flowchart LR`),
 * any `classDef`/`style` lines, and whatever surrounds the graph. `id` maps a node name to its
 * id in the lines and `subgraphs` lists the subgraph ids, so a caller can style them or draw
 * edges to its own pseudo-nodes.
 */
export function mermaidBody<Meta>(
  nodes: Node<Meta>[],
  opts: MermaidOptions<Meta> = {},
): { lines: string[]; id: (name: string) => string; subgraphs: string[] } {
  const ids = new Map(nodes.map((n, i) => [n.name, `n${i}`]));
  const id = (name: string) => {
    const found = ids.get(name);
    if (!found) throw new Error(`mermaidBody: unknown node "${name}"`);
    return found;
  };
  const subgraphOf = (n: Node<Meta>) => opts.subgraphOf?.(n.meta) ?? "";
  const label = opts.label ?? ((n) => n.name);
  const lines: string[] = [];
  const subgraphs: string[] = [];
  for (const [subgraph, members] of Map.groupBy(nodes, subgraphOf)) {
    if (subgraph) {
      const sid = `s${subgraphs.length}`;
      subgraphs.push(sid);
      lines.push(
        `  subgraph ${sid} [${mermaidQuote(opts.subgraphLabel?.(subgraph, subgraphs.length - 1) ?? subgraph)}]`,
      );
    }
    for (const n of members) {
      lines.push(`  ${subgraph ? "  " : ""}${id(n.name)}[${mermaidQuote(label(n))}]`);
    }
    if (subgraph) lines.push("  end");
  }
  for (const n of nodes) {
    for (const d of n.deps) {
      lines.push(`  ${id(d)} ${n.settledDeps?.includes(d) ? "-.->" : "-->"} ${id(n.name)}`);
    }
  }
  if (opts.classOf) {
    const byClass = new Map<string, string[]>();
    for (const n of nodes) {
      const cls = opts.classOf(n);
      if (cls) byClass.set(cls, [...(byClass.get(cls) ?? []), id(n.name)]);
    }
    for (const [cls, members] of byClass) lines.push(`  class ${members.join(",")} ${cls}`);
  }
  return { lines, id, subgraphs };
}
