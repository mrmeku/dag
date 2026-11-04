import type { Graph, Node } from "./graph/index.ts";
import { orchestrate, type RunNode, type Scheduler } from "./orchestrate.ts";
import {
  lookupNode,
  runAction,
  type ActionEvent,
  type CancelledNodeDetails,
  type ExecutionContext,
  type FailedNodeDetails,
  type NodeResult,
  type RunActionOptions,
  type SucceededNodeDetails,
} from "./process-node.ts";
import { unboundedScheduler } from "./schedulers.ts";
import type { OrchestrationEvent } from "./types.ts";

/** One stream of what happens in an execution: orchestration's events and lookup-or-run's. */
export type ExecutionEvent<Meta = unknown> =
  | OrchestrationEvent<Meta, SucceededNodeDetails, FailedNodeDetails, CancelledNodeDetails>
  | ActionEvent<Meta>;

/**
 * Receives each `ExecutionEvent`, as an `OrchestrationListener` receives orchestration's and an
 * `ActionListener` lookup-or-run's.
 */
export type ExecutionListener<Meta = unknown> = (event: ExecutionEvent<Meta>) => unknown;

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

/**
 * Run a graph in one process: orchestration, and each node processed in the same process with
 * the same graph and `onEvent`. Returns one result per node, in the order they settled.
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

/**
 * The `RunNode` that `execute` uses: each node of `graph` processed in this process, its lookup
 * first, given its deps' entries, and, on a miss, its action once the scheduler lets it run. A
 * cancel while it waits settles it `cancelled`.
 */
export function runNode<Ports, Meta>(
  graph: Graph<Ports, Meta>,
  executionContext: ExecutionContext<NoInfer<Ports>>,
  options: RunActionOptions<Meta> = {},
): RunNode<Node<Meta>, SucceededNodeDetails, FailedNodeDetails, CancelledNodeDetails> {
  return async (node, depDetails, waitForScheduler) => {
    const depEntries = Object.fromEntries(
      Object.entries(depDetails).map(([dep, details]) => [dep, details.entry]),
    );
    const found = await lookupNode(graph, node.name, depEntries, executionContext);
    if (found.status !== "missed") return found;
    try {
      await waitForScheduler();
    } catch {
      return { name: found.name, status: "cancelled", details: { actionKey: found.actionKey } };
    }
    return runAction(graph, found, depEntries, executionContext, options);
  };
}
