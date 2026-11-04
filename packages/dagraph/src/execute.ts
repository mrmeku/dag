import type { Graph } from "./graph/index.ts";
import {
  runNode,
  type ActionEvent,
  type CancelledNodeDetails,
  type ExecutionContext,
  type FailedNodeDetails,
  type NodeResult,
  type StartTimer,
  type SucceededNodeDetails,
} from "./lookup-or-run/index.ts";
import {
  orchestrate,
  type Clock,
  type OrchestrationEvent,
  type Scheduler,
} from "./orchestration/index.ts";
import { unboundedScheduler } from "./schedulers/index.ts";

/** One stream of what happens in an execution: orchestration's events and lookup-or-run's. */
export type ExecutionEvent<Meta = unknown> =
  | OrchestrationEvent<Meta, SucceededNodeDetails, FailedNodeDetails, CancelledNodeDetails>
  | ActionEvent<Meta>;

/**
 * Receives each `ExecutionEvent`, as an `OrchestrationListener` receives orchestration's and an
 * `ActionListener` lookup-or-run's.
 */
export type ExecutionListener<Meta = unknown> = (
  event: ExecutionEvent<Meta>,
) => void | Promise<void>;

/** The options of one execution. The execution context outlives it. */
export interface ExecuteOptions<Meta = unknown> {
  onEvent?: ExecutionListener<Meta>;
  scheduler?: Scheduler;
  /**
   * Cancels the execution: nodes still waiting settle `cancelled` and nothing new starts. A
   * running node gets the signal through its action context and settles `cancelled` whatever its
   * action returns. The returned results are complete either way.
   */
  signal?: AbortSignal;
}

/** `Clock` from the global `Date`: what an `ExecutionContext` takes outside a test. */
export const wallClock: Clock = {
  // eslint-disable-next-line no-restricted-syntax -- the wall clock is what reads Date
  epochMilliseconds: () => Date.now(),
};

/** `StartTimer` from the global timers: what an `ExecutionContext` takes outside a test. */
export const startGlobalTimer: StartTimer = (ms, onTimeout) => {
  const timer = setTimeout(onTimeout, ms);
  return () => clearTimeout(timer);
};

/**
 * Run a graph in one process: orchestration, with lookup-or-run's `runNode` looking up and running
 * each node in the same process with the same graph and `onEvent`. Returns one result per node,
 * in the order they settled.
 */
export function execute<Ports, Meta>(
  graph: Graph<Ports, Meta>,
  executionContext: ExecutionContext<NoInfer<Ports>>,
  options: ExecuteOptions<Meta> = {},
): Promise<NodeResult[]> {
  const { onEvent, scheduler = unboundedScheduler(), signal } = options;
  const run = runNode(graph, executionContext, {
    ...(signal && { signal }),
    ...(onEvent && { onEvent }),
  });
  return orchestrate(graph.describe(), run, scheduler, executionContext.clock, onEvent, signal);
}
