import { requiredDeps, type Node, type Outputs } from "./graph/index.ts";
import type { ExecEvent, ExecResult, ProcessNodeResult } from "./types.ts";

export type { ExecEvent, ExecResult, ProcessNodeResult } from "./types.ts";

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
 * State machine that tracks which nodes are ready, in-flight, completed, or failed. Manages the
 * ready queue and dependency fan-out: when a node completes, its dependents become ready if all
 * their other deps are also done. Ready nodes are ordered by root priority, with newly-ready
 * nodes first among equals (depth-first). Used internally by orchestrate().
 */
export class ExecState {
  private dependents: Map<string, Node[]>;
  private priority: Map<string, number>;
  private outputs = new Map<string, Outputs>();
  private contentHashes = new Map<string, string>();
  private execResults = new Map<string, ExecResult>();
  private failed = new Set<string>();
  private ready: Node[];
  private enqueued: Set<string>;
  inflight = 0;

  constructor(nodes: Iterable<Node>) {
    const allNodes = Array.from(nodes);
    const leaves = allNodes.filter((n) => n.deps.length === 0);
    this.dependents = buildDependents(allNodes);
    this.priority = rootPriorities(allNodes);
    this.ready = leaves;
    this.enqueued = new Set(leaves.map((n) => n.name));
  }

  /**
   * Pop the next ready node (optionally matching a filter). Returns null if no node is available.
   * The scheduler calls this in a loop to pull work.
   */
  tryTakeNext(filter?: (node: Node) => boolean): Node | null {
    if (this.ready.length === 0) return null;
    const idx = filter ? this.ready.findIndex(filter) : 0;
    if (idx === -1) return null;
    const node = this.ready.splice(idx, 1)[0]!;
    this.inflight++;
    return node;
  }

  /**
   * Apply a state transition. Updates internal tracking (outputs, hashes, results, failed set)
   * and on "settled" promotes newly-ready dependents to the ready queue.
   */
  send(event: ExecEvent): void {
    switch (event.type) {
      case "dispatch":
      case "start":
        return;
      case "settled": {
        this.inflight--;
        const children = (this.dependents.get(event.node.name) ?? []).filter(
          (child) =>
            !this.enqueued.has(child.name) && child.deps.every((d) => this.execResults.has(d)),
        );
        this.ready.unshift(...children);
        this.ready.sort((a, b) => this.priority.get(a.name)! - this.priority.get(b.name)!);
        for (const c of children) this.enqueued.add(c.name);
        return;
      }
      case "cached": {
        const { node, actionKey, outputs, contentHash } = event;
        this.outputs.set(node.name, outputs);
        this.contentHashes.set(node.name, contentHash);
        this.execResults.set(node.name, {
          name: node.name,
          actionKey,
          status: "cached",
          outputs,
          contentHash,
        });
        return;
      }
      case "done": {
        const { node, actionKey, outputs, contentHash } = event;
        this.outputs.set(node.name, outputs);
        this.contentHashes.set(node.name, contentHash);
        this.execResults.set(node.name, {
          name: node.name,
          actionKey,
          status: "done",
          outputs,
          contentHash,
        });
        return;
      }
      case "fail": {
        const { node } = event;
        const error = event.error instanceof Error ? event.error : new Error(String(event.error));
        this.failed.add(node.name);
        this.execResults.set(node.name, {
          name: node.name,
          actionKey: event.actionKey,
          status: "fail",
          error,
        });
        return;
      }
      case "dep-failed": {
        const { node } = event;
        const error = event.error instanceof Error ? event.error : new Error(String(event.error));
        this.failed.add(node.name);
        this.execResults.set(node.name, {
          name: node.name,
          actionKey: "",
          status: "dep-failed",
          error,
        });
        return;
      }
      case "cancelled":
        this.failed.add(event.node.name);
        this.execResults.set(event.node.name, {
          name: event.node.name,
          actionKey: event.actionKey,
          status: "cancelled",
        });
        return;
    }
  }

  get hasWork(): boolean {
    return this.ready.length > 0 || this.inflight > 0;
  }

  inputsFor(node: Node): Record<string, Outputs> {
    return Object.fromEntries(
      node.deps.filter((d) => this.outputs.has(d)).map((d) => [d, this.outputs.get(d)!]),
    );
  }

  failedDep(node: Node): string | undefined {
    return requiredDeps(node).find((d) => this.failed.has(d));
  }

  getContentHash(name: string): string | undefined {
    return this.contentHashes.get(name);
  }

  get results(): ReadonlyMap<string, ExecResult> {
    return this.execResults;
  }

  /**
   * Convert a ProcessNodeResult into the ExecEvent sequence that should be dispatched. `start` is
   * not among them: the runner emits it when the action begins, before the result exists.
   */
  static resultToEvents(node: Node, result: ProcessNodeResult): ExecEvent[] {
    switch (result.status) {
      case "cached":
        return [
          {
            type: "cached",
            node,
            actionKey: result.actionKey,
            outputs: result.outputs,
            contentHash: result.contentHash,
          },
        ];
      case "done":
        return [
          {
            type: "done",
            node,
            actionKey: result.actionKey,
            outputs: result.outputs,
            contentHash: result.contentHash,
            elapsed: result.elapsed,
          },
        ];
      case "fail":
        return [
          {
            type: "fail",
            node,
            actionKey: result.actionKey,
            error: result.timedOut
              ? Object.assign(new Error(result.error), { name: "TimeoutError" })
              : new Error(result.error),
            elapsed: result.elapsed,
          },
        ];
      case "dep-failed":
        return [{ type: "dep-failed", node, error: new Error(result.error) }];
      case "cancelled":
        return [{ type: "cancelled", node, actionKey: result.actionKey }];
    }
  }
}
