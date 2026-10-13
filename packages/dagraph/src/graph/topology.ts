/**
 * DFS-based cycle detection. Returns nodes in topological order (deps before dependents).
 * Throws if a cycle is found.
 */
export function validateNoCycles(nodes: ReadonlyMap<string, { deps: string[] }>): string[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`cycle detected at ${name}`);
    visiting.add(name);
    const node = nodes.get(name);
    if (!node) throw new Error(`unknown node: ${name}`);
    for (const dep of node.deps) visit(dep);
    visiting.delete(name);
    visited.add(name);
    order.push(name);
  };

  for (const name of nodes.keys()) visit(name);
  return order;
}
