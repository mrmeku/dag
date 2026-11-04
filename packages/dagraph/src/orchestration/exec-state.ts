import type { Ready } from "./ports.ts";
import { isSucceeded, requiredDeps, type Result, type ScheduledNode } from "./types.ts";

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
 * branch finishes before the next starts. A pending node is ready again, in the same order.
 */
export class ExecState<
  NodeData extends ScheduledNode,
  SuccessDetails,
  FailureDetails,
  CancellationDetails,
> {
  private dependents: Map<string, NodeData[]>;
  private priority: Map<string, number>;
  readonly results = new Map<string, Result<SuccessDetails, FailureDetails, CancellationDetails>>();
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

  /** A node waiting for its slot is ready again, pending, until the scheduler lets it run. */
  waitForScheduler(node: NodeData): void {
    this.enqueue([{ node, pending: true }]);
  }

  /** Record a node's result, and make ready each dependent whose deps have all settled. */
  settle(
    node: NodeData,
    result: Result<SuccessDetails, FailureDetails, CancellationDetails>,
  ): void {
    this.results.set(node.name, result);
    this.ready = this.ready.filter((r) => r.node.name !== node.name);
    const children = (this.dependents.get(node.name) ?? []).filter(
      (child) => !this.results.has(child.name) && child.deps.every((d) => this.results.has(d)),
    );
    this.enqueue(children.map((child) => ({ node: child, pending: false })));
  }

  get hasReady(): boolean {
    return this.ready.length > 0;
  }

  /** The details of each dep that succeeded, by dep name. */
  depDetails(node: ScheduledNode): Record<string, SuccessDetails> {
    return Object.fromEntries(
      node.deps.flatMap((d): [string, SuccessDetails][] => {
        const result = this.results.get(d);
        return result?.status === "succeeded" ? [[d, result.details]] : [];
      }),
    );
  }

  /** The first required dep that did not succeed. */
  failedDep(node: ScheduledNode): string | undefined {
    return requiredDeps(node).find((d) => this.results.get(d)?.status !== "succeeded");
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
