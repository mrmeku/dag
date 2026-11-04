import { ExecState, type Ready } from "./exec-state.ts";
import type {
  Clock,
  OrchestrationEvent,
  OrchestrationListener,
  Result,
  ScheduledNode,
} from "./types.ts";
import { errorOf } from "./utils.ts";

export type { Ready } from "./exec-state.ts";

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

/**
 * The scheduling half of `execute`, for an executor that processes nodes elsewhere. It works on
 * nodes as data: it tracks which are ready, admits them through the scheduler, hands each its
 * deps' details, and propagates a failure. It does no I/O, never reads a details and never sees
 * an action, so it runs in a sandbox such as Temporal's workflow.
 *
 * A throw of `onEvent` stops nothing: once the nodes settle, `orchestrate` rejects with the first
 * error that it threw.
 */
export async function orchestrate<
  Meta,
  NodeData extends ScheduledNode<Meta>,
  SuccessDetails,
  FailureDetails,
  CancellationDetails,
>(
  nodes: Iterable<NodeData>,
  run: RunNode<NodeData, SuccessDetails, FailureDetails, CancellationDetails>,
  schedule: Scheduler,
  clock: Clock,
  onEvent?: OrchestrationListener<Meta, SuccessDetails, FailureDetails, CancellationDetails>,
  signal?: AbortSignal,
): Promise<Result<SuccessDetails, FailureDetails, CancellationDetails>[]> {
  type Settled = Result<SuccessDetails, FailureDetails, CancellationDetails>;
  const all = [...nodes];
  const given = new Set(all.map((n) => n.name));
  const unmet = all.flatMap((n) => {
    const absent = n.deps.filter((d) => !given.has(d));
    return absent.length > 0 ? [`"${n.name}" needs ${absent.map((d) => `"${d}"`).join(", ")}`] : [];
  });
  if (unmet.length > 0)
    throw new Error(`orchestrate: nodes depend on nodes it was not given: ${unmet.join("; ")}`);
  const state = new ExecState<NodeData, SuccessDetails, FailureDetails, CancellationDetails>(all);
  let processing = 0;
  let resumeLoop: () => void = () => {};
  const wake = () => resumeLoop();
  signal?.addEventListener("abort", wake, { once: true });
  let listenerError: { thrown: unknown } | undefined;
  const emit = (
    event: OrchestrationEvent<Meta, SuccessDetails, FailureDetails, CancellationDetails>,
  ) => {
    const failed = (thrown: unknown) => {
      listenerError ??= { thrown };
    };
    try {
      const returned = onEvent?.(event);
      if (returned instanceof Promise) returned.catch(failed);
    } catch (thrown) {
      failed(thrown);
    }
  };
  /** Resolves the scheduler's `run` for the place each node holds. */
  const places = new Map<string, () => void>();
  const releasePlace = (name: string) => {
    places.get(name)?.();
    places.delete(name);
  };
  /** What each pending node awaits: the scheduler letting it run. */
  const pendingRuns = new Map<string, { resolve: () => void; reject: (reason: unknown) => void }>();

  const meta = (node: ScheduledNode<Meta>) => (node.meta === undefined ? {} : { meta: node.meta });
  const settle = (node: NodeData, result: Settled) => {
    state.settle(node, result);
    emit({ type: "result", node: node.name, ...meta(node), result, occurredAt: clock.now() });
    releasePlace(node.name);
    wake();
  };

  // Once cancelled, every node that becomes ready settles cancelled instead of running, and every
  // pending node stops waiting, so the loop drains as running nodes settle.
  const drainCancelled = () => {
    let next: Ready<NodeData> | null;
    while ((next = state.take())) {
      if (next.pending) pendingRuns.get(next.node.name)?.reject(signal?.reason);
      else settle(next.node, { name: next.node.name, status: "cancelled" });
    }
  };

  const waitForSchedulerOf = (node: NodeData) => {
    let admitted: Promise<void> | undefined;
    const pend = () => {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (node.concurrencyGroup === undefined) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        pendingRuns.set(node.name, { resolve, reject });
        state.waitForScheduler(node);
        emit({ type: "pending", node: node.name, ...meta(node), occurredAt: clock.now() });
        releasePlace(node.name);
        wake();
      });
    };
    return () => (admitted ??= pend());
  };

  const ctx: SchedulerContext<NodeData> = {
    take(filter) {
      if (signal?.aborted) {
        drainCancelled();
        return null;
      }
      return state.take(filter);
    },
    run({ node, pending }) {
      if (pending) {
        const pendingRun = pendingRuns.get(node.name);
        pendingRuns.delete(node.name);
        if (!pendingRun) return Promise.resolve();
        const place = new Promise<void>((resolve) => places.set(node.name, resolve));
        pendingRun.resolve();
        return place;
      }
      const place = new Promise<void>((resolve) => places.set(node.name, resolve));
      const dep = state.failedDep(node);
      if (dep !== undefined) {
        const rootCauses = state.rootCauses(node);
        settle(node, { name: node.name, status: "dep-failed", dep, rootCauses });
        return place;
      }
      emit({ type: "dispatch", node: node.name, ...meta(node), occurredAt: clock.now() });
      processing++;
      void run(node, state.depDetails(node), waitForSchedulerOf(node))
        .catch((e: unknown): Settled => {
          if (signal?.aborted) return { name: node.name, status: "cancelled" };
          return { name: node.name, status: "failed", error: errorOf(e) };
        })
        .then((result) => {
          processing--;
          pendingRuns.delete(node.name);
          settle(node, result);
        });
      return place;
    },
    hasWork() {
      return state.hasReady || processing > 0;
    },
    workAvailable() {
      if (processing === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        resumeLoop = resolve;
      });
    },
  };

  try {
    await schedule(ctx);
  } finally {
    signal?.removeEventListener("abort", wake);
  }
  if (listenerError) throw listenerError.thrown;
  return [...state.results.values()];
}
