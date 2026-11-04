import type { OrchestrationEvent, Result, ScheduledNode } from "./types.ts";

/**
 * The time, for stamping events and timing actions, in milliseconds since the Unix epoch, as
 * Temporal names it. `wallClock` fills it from `Date`; one on the Temporal API is
 * `{ epochMilliseconds: () => Temporal.Now.instant().epochMilliseconds }`.
 */
export interface Clock {
  epochMilliseconds: () => number;
}

/**
 * Receives each `OrchestrationEvent`. A throw, or a returned promise that rejects before the
 * execution ends, rejects the execution at its end.
 */
export type OrchestrationListener<Meta, SuccessDetails, FailureDetails, CancellationDetails> = (
  event: OrchestrationEvent<Meta, SuccessDetails, FailureDetails, CancellationDetails>,
) => void | Promise<void>;

/**
 * Runs one node somewhere, given the details of its deps that succeeded by dep name, and returns
 * its result. Before the work that needs a slot it awaits `waitForScheduler`, which resolves once
 * the scheduler lets it run, and rejects once the execution is cancelled. A rejection of `RunNode`
 * settles the node `failed`, with no details, or `cancelled` once the execution is cancelled.
 */
export type RunNode<
  NodeData extends ScheduledNode,
  SuccessDetails,
  FailureDetails,
  CancellationDetails,
> = (
  node: NodeData,
  depDetails: Record<string, SuccessDetails>,
  waitForScheduler: () => Promise<void>,
) => Promise<Result<SuccessDetails, FailureDetails, CancellationDetails>>;

/** A node the scheduler may take: ready to be dispatched, or pending until it may take its slot. */
export interface Ready<NodeData extends ScheduledNode = ScheduledNode> {
  node: NodeData;
  pending: boolean;
}

/**
 * What a scheduler drives. `take` returns the first ready node, in orchestration's order, that
 * `filter` admits: a node comes once when it is ready and, when it waits for its slot and it has
 * a concurrency group, again `pending`. `run` dispatches a ready node, or lets a pending one run; it resolves once the node settles or, as it begins to pend, gives its place back. `workAvailable` resolves when that may have changed what `take` returns.
 */
export interface SchedulerContext<NodeData extends ScheduledNode = ScheduledNode> {
  take(filter?: (ready: Ready<NodeData>) => boolean): Ready<NodeData> | null;
  run(ready: Ready<NodeData>): Promise<void>;
  hasWork(): boolean;
  workAvailable(): Promise<void>;
}

/**
 * The policy that admits ready nodes. It takes them in orchestration's order and only filters
 * it: it may hold a node back, but never reorders them.
 */
export type Scheduler = <NodeData extends ScheduledNode>(
  ctx: SchedulerContext<NodeData>,
) => Promise<void>;
