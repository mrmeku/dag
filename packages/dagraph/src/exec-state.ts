import type { CacheEntry } from "./cache.ts";
import { requiredDeps, type Node } from "./graph/index.ts";
import type { Result } from "./types.ts";

/** A node the scheduler may take: ready to be processed, or a miss waiting for its group's slot. */
export interface Ready {
  node: Node;
  acquiring: boolean;
}

/** Build the reverse adjacency list: for each node, which nodes depend on it. */
function buildDependents(nodes: Iterable<Node>): Map<string, Node[]> {
  const acc = new Map<string, Node[]>();
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (!acc.has(dep)) acc.set(dep, []);
      acc.get(dep)!.push(node);
    }
  }
  return acc;
}

/**
 * Priority of each node: the insertion position of the earliest-added root it descends from.
 * Lower runs first, so work for earlier-added roots is preferred over later ones.
 */
function rootPriorities(nodes: Node[]): Map<string, number> {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const position = new Map(nodes.map((n, i) => [n.name, i]));
  const priority = new Map<string, number>();
  const visit = (node: Node): number => {
    const known = priority.get(node.name);
    if (known !== undefined) return known;
    const deps = node.deps.flatMap((d) => byName.get(d) ?? []);
    const p = deps.length === 0 ? position.get(node.name)! : Math.min(...deps.map(visit));
    priority.set(node.name, p);
    return p;
  };
  nodes.forEach(visit);
  return priority;
}

/**
 * Which nodes are ready, which settled and how. A node is ready once every dep has settled.
 * Ready nodes are ordered by root priority, the most recently ready first among equals, so one
 * branch finishes before the next starts. A miss waiting for its group's slot is ready again, in
 * the same order.
 */
export class ExecState {
  private dependents: Map<string, Node[]>;
  private priority: Map<string, number>;
  private entries = new Map<string, CacheEntry>();
  readonly results = new Map<string, Result>();
  private ready: Ready[];

  constructor(nodes: Iterable<Node>) {
    const allNodes = Array.from(nodes);
    this.dependents = buildDependents(allNodes);
    this.priority = rootPriorities(allNodes);
    this.ready = allNodes
      .filter((n) => n.deps.length === 0)
      .map((node) => ({ node, acquiring: false }));
  }

  private enqueue(items: Ready[]): void {
    this.ready.unshift(...items);
    this.ready.sort((a, b) => this.priority.get(a.node.name)! - this.priority.get(b.node.name)!);
  }

  /** Remove and return the first ready node `filter` admits, or null. */
  take(filter?: (ready: Ready) => boolean): Ready | null {
    const idx = filter ? this.ready.findIndex(filter) : 0;
    if (idx === -1 || idx >= this.ready.length) return null;
    return this.ready.splice(idx, 1)[0]!;
  }

  /** A miss waits for its group's slot: it is ready again, acquiring. */
  waitForSlot(node: Node): void {
    this.enqueue([{ node, acquiring: true }]);
  }

  /** Record a node's result, and make ready each dependent whose deps have all settled. */
  settle(node: Node, result: Result): void {
    this.results.set(node.name, result);
    this.ready = this.ready.filter((r) => r.node.name !== node.name);
    if (result.status === "done" || result.status === "cached")
      this.entries.set(node.name, { outputs: result.outputs, contentHash: result.contentHash });
    const children = (this.dependents.get(node.name) ?? []).filter(
      (child) => !this.results.has(child.name) && child.deps.every((d) => this.results.has(d)),
    );
    this.enqueue(children.map((child) => ({ node: child, acquiring: false })));
  }

  get hasReady(): boolean {
    return this.ready.length > 0;
  }

  /** The entry of each dep that succeeded, by dep name. */
  depEntries(node: Node): Record<string, CacheEntry> {
    return Object.fromEntries(
      node.deps.filter((d) => this.entries.has(d)).map((d) => [d, this.entries.get(d)!]),
    );
  }

  /** The first required dep that did not succeed. */
  failedDep(node: Node): string | undefined {
    return requiredDeps(node).find((d) => !this.entries.has(d));
  }
}
