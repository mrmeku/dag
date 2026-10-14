import { validateNoCycles } from "./topology.ts";
import type { AnalysisResult, Node, RunnableNode } from "./types.ts";

/** The longest delay setTimeout honors; a longer one fires at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Mutable DAG container. Nodes are added incrementally via add() and namespaced via subgraph().
 * The graph validates deps exist on add but defers cycle detection to analyze()/execute().
 */
export class Graph {
  private nodes: Map<string, RunnableNode>;
  private prefix: string;

  constructor(prefix = "", nodes?: Map<string, RunnableNode>) {
    this.prefix = prefix;
    this.nodes = nodes ?? new Map();
  }

  /**
   * Register a node in the graph. Validates no duplicate names, that all deps exist, and the timeout.
   * Returns the fully-qualified name (including scope prefix).
   */
  add(def: RunnableNode): string {
    const name = this.prefix ? `${this.prefix}:${def.name}` : def.name;
    const prefixed = this.prefix ? { ...def, name } : def;
    if (this.nodes.has(name)) {
      const colon = name.indexOf(":");
      if (colon === -1) {
        throw new Error(
          `Duplicate node name "${name}". A node with this name already exists.\n` +
            `  Hint: If you're adding multiple instances of the same action, wrap each group\n` +
            `  in graph.subgraph(id) to namespace them — e.g. graph.subgraph("abc123").`,
        );
      }
      const scope = name.slice(0, colon);
      const kind = name.slice(colon + 1);
      const existingNode = this.nodes.get(name)!;
      const existingColon = existingNode.name.indexOf(":");
      if (existingColon !== -1 && existingNode.name.slice(0, existingColon) === scope) {
        throw new Error(
          `Duplicate node name "${name}". A node with this name already exists in scope "${scope}".\n` +
            `  Hint: If you need multiple "${kind}" nodes in the same scope, use distinct kind values.`,
        );
      }
      throw new Error(
        `Duplicate node name "${name}". A node with this name already exists.\n` +
          `  Hint: This may be a conflict between a subgraph node (via graph.subgraph("${scope}"))\n` +
          `  and a manually-named node. Check for hardcoded names that match the scope:kind pattern.`,
      );
    }
    const t = prefixed.timeoutMs;
    if (t !== undefined && !(Number.isInteger(t) && t > 0 && t <= MAX_TIMEOUT_MS)) {
      throw new RangeError(
        `node "${name}": timeoutMs must be a whole number of ms from 1 to ${MAX_TIMEOUT_MS}, got ${t}`,
      );
    }
    for (const d of prefixed.deps) {
      if (!this.nodes.has(d)) throw new Error(`node "${name}" depends on unknown node "${d}"`);
    }
    this.nodes.set(name, prefixed);
    return name;
  }

  /**
   * Create a namespaced sub-portion of this graph. Nodes added via the subgraph get a "prefix:name"
   * key, allowing multiple instances of the same action kind (e.g. one per video).
   */
  subgraph(prefix: string): Graph {
    const fullPrefix = this.prefix ? `${this.prefix}:${prefix}` : prefix;
    return new Graph(fullPrefix, this.nodes);
  }

  /** Return all registered nodes. Used by the executor to look up RunnableNodes by name. */
  getNodes(): ReadonlyMap<string, RunnableNode> {
    return this.nodes;
  }

  /** Return the graph as serializable nodes — no closures, safe for Temporal workflow sandbox. */
  describe(): Node[] {
    return Array.from(this.nodes.values()).map(
      ({ action: _action, params: _params, normalize: _normalize, ...node }) => node,
    );
  }

  /** Validate the graph has no cycles and return structural info (node count, count by kind). */
  analyze(): AnalysisResult {
    validateNoCycles(this.nodes);
    const nodes = Array.from(this.nodes.values());
    const byKind = new Map(
      Array.from(
        Map.groupBy(nodes, (n) => n.kind),
        ([kind, group]) => [kind, group.length],
      ),
    );
    return { nodes, total: nodes.length, byKind };
  }
}
