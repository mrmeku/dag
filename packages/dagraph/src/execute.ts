import type { Graph } from "./graph/index.ts";
import { orchestrate, type RunNode, type Scheduler } from "./orchestrate.ts";
import { inputHashMemos, processNode, type ExecutionContext } from "./process-node.ts";
import { unboundedScheduler } from "./schedulers.ts";
import type { ExecEvent, Result } from "./types.ts";

/** The options of one execution. The execution context outlives it. */
export interface ExecuteOptions<Meta = unknown> {
  /** Every node skips its entry read, runs, and writes its new entry. */
  force?: boolean;
  onEvent?: (event: ExecEvent<Meta>) => void;
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
 * the same graph and `onEvent`. Each input file is hashed once per execution, however many
 * nodes declare it. Returns one result per node, in the order they settled.
 */
export function execute<Ports, Meta>(
  graph: Graph<Ports, Meta>,
  executionContext: ExecutionContext<NoInfer<Ports>>,
  options: ExecuteOptions<Meta> = {},
): Promise<Result[]> {
  // v0.3.0's per-node forms, which an untyped caller can still pass: refused, never misread.
  const perNode = "A choice per node is an executor's: pass it in processNode's options";
  if ("cacheOnly" in options)
    return Promise.reject(new Error(`execute takes no cacheOnly. ${perNode}.`));
  if (options.force !== undefined && typeof options.force !== "boolean")
    return Promise.reject(new Error(`execute's force is true or false. ${perNode}.`));
  const { force = false, onEvent, scheduler = unboundedScheduler(), signal } = options;
  const execution = { ...executionContext };
  inputHashMemos.set(execution, new Map());
  const run: RunNode<Meta> = (node, depEntries, acquire) =>
    processNode(graph, node.name, depEntries, execution, {
      force,
      acquire,
      ...(signal && { signal }),
      ...(onEvent && { onEvent }),
    });
  return orchestrate(graph.describe(), run, scheduler, onEvent, signal);
}
