import type { ExecEvent, ExecResult } from "./exec-state.ts";
import type { Graph, Node } from "./graph/index.ts";
import { validateNoCycles } from "./graph/index.ts";
import type { RunNode, Scheduler } from "./orchestrate.ts";
import { orchestrate } from "./orchestrate.ts";
import { processNode, type ExecutionContext } from "./process-node.ts";
import { unboundedScheduler } from "./schedulers.ts";

export {
  NOT_CACHED,
  processNode,
  type ExecutionContext,
  type ProcessNodeOptions,
} from "./process-node.ts";

/** A per-run switch: on for every node, or for the nodes a predicate selects. */
export type NodeSwitch = boolean | ((node: Node) => boolean);

/**
 * Per-invocation overrides for DAG execution. Separate from ExecutionContext because these vary
 * per run (e.g. --force for a retry) while the context is stable infrastructure.
 */
export interface ExecuteOptions {
  /**
   * Re-run the selected nodes even when a cached result exists, then store the new one. Their
   * dependents re-run only if the output actually changed (early cutoff).
   */
  force?: NodeSwitch;
  /**
   * Hold back the selected nodes: one without a verified cache entry fails with NOT_CACHED and
   * its dependents dep-fail. Reports the cache's state of a graph without doing its work.
   */
  cacheOnly?: NodeSwitch;
  onEvent?: (event: ExecEvent) => void;
  scheduler?: Scheduler;
  /**
   * Cancels the execution: nodes still waiting settle as `cancelled` and nothing new starts.
   * Nodes already running get the signal through their action context and settle as
   * `cancelled` whatever their action returns; nothing they produce is cached. The returned
   * results are complete either way.
   */
  signal?: AbortSignal;
}

const selects = (sw: NodeSwitch | undefined, node: Node) =>
  typeof sw === "function" ? sw(node) : (sw ?? false);

/**
 * Run an entire DAG to completion. This is the primary entry point for dagraph — call it with a
 * built Graph, an ExecutionContext (cache + fs), and optional scheduling overrides. Returns
 * per-node results (done, cached, fail, dep-failed, cancelled).
 */
export async function execute(
  graph: Graph,
  ctx: ExecutionContext,
  opts?: ExecuteOptions,
): Promise<ExecResult[]> {
  const nodes = graph.getNodes();
  validateNoCycles(nodes);
  const scheduler = opts?.scheduler ?? unboundedScheduler();
  const execCtx = { ...ctx, inputHashes: ctx.inputHashes ?? new Map() };
  const run: RunNode = (desc, depContentHashes, depOutputs, started) => {
    const node = nodes.get(desc.name)!;
    return processNode(node, depContentHashes, depOutputs, execCtx, {
      force: selects(opts?.force, node),
      cacheOnly: selects(opts?.cacheOnly, node),
      ...(opts?.signal && { signal: opts.signal }),
      onStart: started,
    });
  };
  return orchestrate(nodes.values(), run, scheduler, opts?.onEvent, opts?.signal);
}
