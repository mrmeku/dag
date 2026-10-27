import type { Graph } from "./graph/index.ts";
import { orchestrate, type Scheduler } from "./orchestrate.ts";
import { localRunNode, type ExecutionContext } from "./process-node.ts";
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
  const run = localRunNode(graph, executionContext, {
    ...(signal && { signal }),
    ...(onEvent && { onEvent }),
  });
  return orchestrate(graph.describe(), run, scheduler, onEvent, signal);
}
