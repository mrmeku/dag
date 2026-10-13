import type { Node } from "./graph/index.ts";

export interface MermaidOptions {
  /** Text inside a node's box. Default: the name, minus its scope when drawn inside one. */
  label?: (node: Node, scope: string) => string;
  /** Which subgraph a node belongs to. Default: its `scope:` prefix, none for bare names. */
  subgraphOf?: (node: Node) => string;
  /** Title of a subgraph, given its scope and its index. Default: the scope itself. */
  subgraphLabel?: (scope: string, index: number) => string;
  /** A class name per node, applied with `class` lines. Default: none. */
  classOf?: (node: Node) => string | undefined;
}

export function scopeOf(name: string): string {
  const i = name.lastIndexOf(":");
  return i === -1 ? "" : name.slice(0, i);
}

/**
 * The body of a mermaid flowchart for a set of nodes: one box per node, scopes as subgraphs
 * (ids `s0`, `s1`, …), one edge per dependency (dashed when optional), then `class` lines
 * grouping nodes by the class `classOf` gives them. Callers add the header (`flowchart LR`),
 * any `classDef`/`style` lines, and whatever surrounds the graph. `id` maps a node name to its
 * id in the lines and `subgraphs` lists the subgraph ids, so a caller can style them or draw
 * edges to its own pseudo-nodes.
 */
export function mermaidBody(
  nodes: Node[],
  opts: MermaidOptions = {},
): { lines: string[]; id: (name: string) => string; subgraphs: string[] } {
  const ids = new Map(nodes.map((n, i) => [n.name, `n${i}`]));
  const id = (name: string) => {
    const found = ids.get(name);
    if (!found) throw new Error(`mermaidBody: unknown node "${name}"`);
    return found;
  };
  const subgraphOf = opts.subgraphOf ?? ((n) => scopeOf(n.name));
  const label = opts.label ?? ((n, scope) => (scope ? n.name.slice(scope.length + 1) : n.name));
  const quote = (s: string) => `"${s.replace(/"/g, "#quot;")}"`;
  const lines: string[] = [];
  const subgraphs: string[] = [];
  for (const [scope, members] of Map.groupBy(nodes, subgraphOf)) {
    if (scope) {
      const sid = `s${subgraphs.length}`;
      subgraphs.push(sid);
      lines.push(
        `  subgraph ${sid} [${quote(opts.subgraphLabel?.(scope, subgraphs.length - 1) ?? scope)}]`,
      );
    }
    for (const n of members) {
      lines.push(`  ${scope ? "  " : ""}${id(n.name)}[${quote(label(n, scope))}]`);
    }
    if (scope) lines.push("  end");
  }
  for (const n of nodes) {
    for (const d of n.deps) {
      lines.push(`  ${id(d)} ${n.optionalDeps?.includes(d) ? "-.->" : "-->"} ${id(n.name)}`);
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
