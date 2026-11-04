import type { CacheEntry } from "./cache.ts";
import { isSucceeded, requiredDeps, type Result, type ScheduledNode } from "./types.ts";

/** A node the scheduler may take: ready to be processed, or a miss pending before its action runs. */
export interface Ready<NodeData extends ScheduledNode = ScheduledNode> {
  node: NodeData;
  pending: boolean;
}

/** Build the reverse adjacency list: for each node, which nodes depend on it. */
function buildDependents<NodeData extends ScheduledNode>(
  nodes: Iterable<NodeData>,
): Map<string, NodeData[]> {
  const acc = new Map<string, NodeData[]>();
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
function rootPriorities(nodes: ScheduledNode[]): Map<string, number> {
  const byName = new Map(nodes.map((node, position) => [node.name, { node, position }]));
  const priority = new Map<string, number>();
  const visit = ({ node, position }: { node: ScheduledNode; position: number }): number => {
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
 * branch finishes before the next starts. A pending miss is ready again, in
 * the same order.
 */
export class ExecState<NodeData extends ScheduledNode = ScheduledNode> {
  private dependents: Map<string, NodeData[]>;
  private priority: Map<string, number>;
  private entries = new Map<string, CacheEntry>();
  readonly results = new Map<string, Result>();
  private ready: Ready<NodeData>[];

  constructor(nodes: Iterable<NodeData>) {
    const allNodes = Array.from(nodes);
    this.dependents = buildDependents(allNodes);
    this.priority = rootPriorities(allNodes);
    this.ready = allNodes
      .filter((n) => n.deps.length === 0)
      .map((node) => ({ node, pending: false }));
  }

  private priorityOf(node: NodeData): number {
    const priority = this.priority.get(node.name);
    if (priority === undefined) throw new Error(`orchestrate was not given "${node.name}"`);
    return priority;
  }

  private enqueue(items: Ready<NodeData>[]): void {
    this.ready.unshift(...items);
    this.ready.sort((a, b) => this.priorityOf(a.node) - this.priorityOf(b.node));
  }

  /** Remove and return the first ready node `filter` admits, or null. */
  take(filter?: (ready: Ready<NodeData>) => boolean): Ready<NodeData> | null {
    const idx = filter ? this.ready.findIndex(filter) : 0;
    if (idx === -1) return null;
    const [taken] = this.ready.splice(idx, 1);
    return taken ?? null;
  }

  /** A miss waits for the scheduler: it is ready again, pending, until the scheduler lets it run. */
  waitForScheduler(node: NodeData): void {
    this.enqueue([{ node, pending: true }]);
  }

  /** Record a node's result, and make ready each dependent whose deps have all settled. */
  settle(node: NodeData, result: Result): void {
    this.results.set(node.name, result);
    this.ready = this.ready.filter((r) => r.node.name !== node.name);
    if (isSucceeded(result))
      this.entries.set(node.name, {
        outputs: result.outputs,
        contentHash: result.contentHash,
        outputHashes: result.outputHashes,
      });
    const children = (this.dependents.get(node.name) ?? []).filter(
      (child) => !this.results.has(child.name) && child.deps.every((d) => this.results.has(d)),
    );
    this.enqueue(children.map((child) => ({ node: child, pending: false })));
  }

  get hasReady(): boolean {
    return this.ready.length > 0;
  }

  /** The entry of each dep that succeeded, by dep name. */
  depEntries(node: ScheduledNode): Record<string, CacheEntry> {
    return Object.fromEntries(
      node.deps.flatMap((d): [string, CacheEntry][] => {
        const entry = this.entries.get(d);
        return entry ? [[d, entry]] : [];
      }),
    );
  }

  /** The first required dep that did not succeed. */
  failedDep(node: ScheduledNode): string | undefined {
    return requiredDeps(node).find((d) => !this.entries.has(d));
  }

  /** The failures behind a held back node, along its required deps, each once. */
  rootCauses(node: ScheduledNode): string[] {
    const causes = requiredDeps(node).flatMap((d) => {
      const result = this.results.get(d);
      if (!result || isSucceeded(result)) return [];
      return result.status === "dep-failed" ? (result.rootCauses ?? [d]) : [d];
    });
    return [...new Set(causes)];
  }
}
