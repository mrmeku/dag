import {
  ExecState,
  type ExecEvent,
  type ExecResult,
  type ProcessNodeResult,
} from "./exec-state.ts";
import type { Node, Outputs } from "./graph/index.ts";

/**
 * Callback that executes a single node given its dep hashes and outputs. The orchestrator calls
 * this for each ready node — the implementation decides *how* to run it (local, remote, etc.).
 */
export type RunNode = (
  node: Node,
  depContentHashes: Map<string, string>,
  depOutputs: Record<string, Outputs>,
) => Promise<ProcessNodeResult>;

/**
 * Interface the scheduler uses to interact with the orchestrator. Provides pull-based node
 * acquisition (take), async execution (run), and backpressure (workAvailable).
 */
export interface SchedulerContext {
  take(filter?: (node: Node) => boolean): Node | null;
  run(node: Node): Promise<void>;
  hasWork(): boolean;
  workAvailable(): Promise<void>;
}

/**
 * Pluggable execution strategy that controls parallelism and ordering. The scheduler pulls
 * ready nodes via ctx.take() and launches them via ctx.run().
 */
export type Scheduler = (ctx: SchedulerContext) => Promise<void>;

/**
 * Coordinate DAG execution with a pluggable scheduler. Bridges the state machine (ExecState)
 * and the scheduler by wiring up node completion callbacks that advance the state and resume
 * the scheduling loop. Most callers should use execute() instead — orchestrate is the lower-level
 * primitive for custom runner setups (e.g. Temporal activities).
 */
export async function orchestrate(
  nodes: Iterable<Node>,
  run: RunNode,
  schedule: Scheduler,
  onEvent?: (event: ExecEvent) => void,
  signal?: AbortSignal,
): Promise<ExecResult[]> {
  const state = new ExecState(nodes);
  let resumeLoop: () => void = () => {};
  signal?.addEventListener("abort", () => resumeLoop(), { once: true });

  const emit = (event: ExecEvent) => {
    state.send(event);
    onEvent?.(event);
  };

  const done = (node: Node, result: ProcessNodeResult) => {
    for (const event of ExecState.resultToEvents(node, result)) emit(event);
    emit({ type: "settled", node });
    resumeLoop();
  };

  // Once cancelled, every node that becomes ready settles as cancelled instead of running, so
  // the scheduler sees nothing to take and the loop drains as in-flight nodes settle.
  const drainCancelled = () => {
    let node: Node | null;
    while ((node = state.tryTakeNext()))
      done(node, { name: node.name, actionKey: "", status: "cancelled" });
  };

  const ctx: SchedulerContext = {
    take(filter) {
      if (signal?.aborted) {
        drainCancelled();
        return null;
      }
      return state.tryTakeNext(filter);
    },
    run(node) {
      const failed = state.failedDep(node);
      if (failed) {
        done(node, {
          name: node.name,
          actionKey: "",
          status: "dep-failed",
          error: `dependency ${failed} failed`,
        });
        return Promise.resolve();
      }
      emit({ type: "dispatch", node });
      const depContentHashes = new Map(
        node.deps
          .filter((d) => state.getContentHash(d) !== undefined)
          .map((d) => [d, state.getContentHash(d)!]),
      );
      const depOutputs = state.inputsFor(node);
      return run(node, depContentHashes, depOutputs)
        .catch(
          (e): ProcessNodeResult => ({
            name: node.name,
            actionKey: "",
            status: "fail",
            error: e instanceof Error ? e.message : String(e),
            elapsed: 0,
          }),
        )
        .then((result) => {
          done(node, result);
        });
    },
    hasWork() {
      return state.hasWork;
    },
    workAvailable() {
      if (state.inflight === 0) return Promise.resolve();
      return new Promise<void>((r) => {
        resumeLoop = r;
      });
    },
  };

  await schedule(ctx);
  return [...state.results.values()];
}
