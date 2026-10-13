import { Graph, validateNoCycles } from "@mrmeku/dagraph";

/** The subgraph needed to run `names`: those nodes and their transitive dependencies. */
export function selectNodes(graph: Graph, names: string[]): Graph {
  const nodes = graph.getNodes();
  const keep = new Set<string>();
  const visit = (name: string) => {
    if (keep.has(name)) return;
    const node = nodes.get(name);
    if (!node) throw new Error(`unknown node "${name}"`);
    keep.add(name);
    node.deps.forEach(visit);
  };
  names.forEach(visit);
  const out = new Graph();
  for (const name of validateNoCycles(nodes)) if (keep.has(name)) out.add(nodes.get(name)!);
  return out;
}
