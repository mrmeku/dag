import type { CacheEntry } from "./cache.ts";
import { requiredDeps, type Node } from "./graph/index.ts";
import { isSucceeded, type Result } from "./types.ts";

/** A node the scheduler may take: ready to be processed, or a miss waiting for its group's slot. */
export interface Ready<Meta = unknown> {
  node: Node<Meta>;
  waitingForSlot: boolean;
}

/** Build the reverse adjacency list: for each node, which nodes depend on it. */
function buildDependents<Meta>(nodes: Iterable<Node<Meta>>): Map<string, Node<Meta>[]> {
  const acc = new Map<string, Node<Meta>[]>();
  for (const node of nodes) {
    for (const dep of node.deps) {
      const dependents = acc.get(dep);
      if (dependents) dependents.push(node);
      else acc.set(dep, [node]);
    }
  }
  return acc;
}

/**
 * Priority of each node: the insertion position of the earliest-added root it descends from.
 * Lower runs first, so work for earlier-added roots is preferred over later ones.
 */
function rootPriorities(nodes: Node[]): Map<string, number> {
  const byName = new Map(nodes.map((node, position) => [node.name, { node, position }]));
  const priority = new Map<string, number>();
  const visit = ({ node, position }: { node: Node; position: number }): number => {
    const known = priority.get(node.name);
    if (known !== undefined) return known;
    const deps = node.deps.flatMap((d) => byName.get(d) ?? []);
    const p = deps.length === 0 ? position : Math.min(...deps.map(visit));
    priority.set(node.name, p);
    return p;
  };
  byName.forEach(visit);
  return priority;
}

/**
 * Which nodes are ready, which settled and how. A node is ready once every dep has settled.
 * Ready nodes are ordered by root priority, the most recently ready first among equals, so one
 * branch finishes before the next starts. A miss waiting for its group's slot is ready again, in
 * the same order.
 */
export class ExecState<Meta = unknown> {
  private dependents: Map<string, Node<Meta>[]>;
  private priority: Map<string, number>;
  private entries = new Map<string, CacheEntry>();
  readonly results = new Map<string, Result>();
  private ready: Ready<Meta>[];

  constructor(nodes: Iterable<Node<Meta>>) {
    const allNodes = Array.from(nodes);
    this.dependents = buildDependents(allNodes);
    this.priority = rootPriorities(allNodes);
    this.ready = allNodes
      .filter((n) => n.deps.length === 0)
      .map((node) => ({ node, waitingForSlot: false }));
  }

  private priorityOf(node: Node<Meta>): number {
    const priority = this.priority.get(node.name);
    if (priority === undefined) throw new Error(`orchestrate was not given "${node.name}"`);
    return priority;
  }

  private enqueue(items: Ready<Meta>[]): void {
    this.ready.unshift(...items);
    this.ready.sort((a, b) => this.priorityOf(a.node) - this.priorityOf(b.node));
  }

  /** Remove and return the first ready node `filter` admits, or null. */
  take(filter?: (ready: Ready<Meta>) => boolean): Ready<Meta> | null {
    const idx = filter ? this.ready.findIndex(filter) : 0;
    if (idx === -1) return null;
    const [taken] = this.ready.splice(idx, 1);
    return taken ?? null;
  }

  /** A miss waits for its group's slot: it is ready again, waiting for its slot. */
  waitForSlot(node: Node<Meta>): void {
    this.enqueue([{ node, waitingForSlot: true }]);
  }

  /** Record a node's result, and make ready each dependent whose deps have all settled. */
  settle(node: Node<Meta>, result: Result): void {
    this.results.set(node.name, result);
    this.ready = this.ready.filter((r) => r.node.name !== node.name);
    if (isSucceeded(result))
      this.entries.set(node.name, { outputs: result.outputs, contentHash: result.contentHash });
    const children = (this.dependents.get(node.name) ?? []).filter(
      (child) => !this.results.has(child.name) && child.deps.every((d) => this.results.has(d)),
    );
    this.enqueue(children.map((child) => ({ node: child, waitingForSlot: false })));
  }

  get hasReady(): boolean {
    return this.ready.length > 0;
  }

  /** The entry of each dep that succeeded, by dep name. */
  depEntries(node: Node): Record<string, CacheEntry> {
    return Object.fromEntries(
      node.deps.flatMap((d): [string, CacheEntry][] => {
        const entry = this.entries.get(d);
        return entry ? [[d, entry]] : [];
      }),
    );
  }

  /** The first required dep that did not succeed. */
  failedDep(node: Node): string | undefined {
    return requiredDeps(node).find((d) => !this.entries.has(d));
  }
}
