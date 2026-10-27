import type { Graph } from "./graph/index.ts";
import { orchestrate, type RunNode, type Scheduler } from "./orchestrate.ts";
import {
  lookupNode,
  runAction,
  type ExecutionContext,
  type RunActionOptions,
} from "./process-node.ts";
import { unboundedScheduler } from "./schedulers.ts";
import type { ExecListener, Result } from "./types.ts";

/** The options of one execution. The execution context outlives it. */
export interface ExecuteOptions<Meta = unknown> {
  onEvent?: ExecListener<Meta>;
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
): Promise<Result[]> {
  const { onEvent, scheduler = unboundedScheduler(), signal } = options;
  const run = runNode(graph, executionContext, {
    ...(signal && { signal }),
    ...(onEvent && { onEvent }),
  });
  return orchestrate(graph.describe(), run, scheduler, onEvent, signal);
}

/**
 * The `RunNode` that `execute` uses: each node of `graph` processed in this process, its lookup
 * first and, on a miss, its action once the scheduler lets it run. A cancel while it waits settles it
 * `cancelled`.
 */
export function runNode<Ports, Meta>(
  graph: Graph<Ports, Meta>,
  executionContext: ExecutionContext<NoInfer<Ports>>,
  options: RunActionOptions<Meta> = {},
): RunNode<Meta> {
  return async (node, depEntries, waitForScheduler) => {
    const found = await lookupNode(graph, node.name, depEntries, executionContext);
    if (found.status !== "missed") return found;
    try {
      await waitForScheduler();
    } catch {
      return { name: found.name, actionKey: found.actionKey, status: "cancelled" };
    }
    return runAction(graph, found, depEntries, executionContext, options);
  };
}
