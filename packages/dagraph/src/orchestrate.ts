import type { CacheEntry } from "./cache.ts";
import { ExecState, type Ready } from "./exec-state.ts";
import type { Node } from "./graph/index.ts";
import type { ExecEvent, ExecListener, Result } from "./types.ts";
import { errorOf } from "./utils.ts";

export type { Ready } from "./exec-state.ts";

/**
 * Processes one node somewhere, given its deps' entries by dep name, and returns its result. On
 * a miss it awaits `acquire`, the gate the scheduler answers once the node's group has a slot,
 * before the action runs. `acquire` rejects once the execution is cancelled. A rejection of
 * `RunNode` becomes a failure, as an action's error does, or `cancelled` once the execution is
 * cancelled.
 */
export type RunNode<Meta = unknown> = (
  node: Node<Meta>,
  depEntries: Record<string, CacheEntry>,
  acquire: () => Promise<void>,
) => Promise<Result>;

/**
 * What a scheduler drives. `take` returns the first ready node, in orchestration's order, that
 * `filter` admits: a node comes once when it is ready and, when its lookup misses and it has a
 * concurrency group, again `acquiring` its group's slot. `run` hands a ready node to processing,
 * or grants an acquiring one its slot; it resolves once the node settles or, waiting for a slot,
 * gives its place back. `workAvailable` resolves when that may have changed what `take` returns.
 */
export interface SchedulerContext<Meta = unknown> {
  take(filter?: (ready: Ready<Meta>) => boolean): Ready<Meta> | null;
  run(ready: Ready<Meta>): Promise<void>;
  hasWork(): boolean;
  workAvailable(): Promise<void>;
}

/**
 * The policy that admits ready nodes. It takes them in orchestration's order and only filters
 * it: it may hold a node back, but never reorders them.
 */
export type Scheduler = <Meta>(ctx: SchedulerContext<Meta>) => Promise<void>;

/**
 * The scheduling half of `execute`, for an executor that processes nodes elsewhere. It works on
 * nodes as data: it tracks which are ready, admits them through the scheduler, hands each its
 * deps' entries, and propagates a failure. It does no I/O, hashes nothing and never sees an
 * action, so it runs in a sandbox such as Temporal's workflow.
 *
 * A throw of `onEvent` stops nothing: once the nodes settle, `orchestrate` rejects with the first
 * error that it threw.
 */
export async function orchestrate<Meta>(
  nodes: Iterable<Node<Meta>>,
  run: RunNode<Meta>,
  schedule: Scheduler,
  onEvent?: ExecListener<Meta>,
  signal?: AbortSignal,
): Promise<Result[]> {
  const all = [...nodes];
  const given = new Set(all.map((n) => n.name));
  const unmet = all.flatMap((n) => {
    const absent = n.deps.filter((d) => !given.has(d));
    return absent.length > 0 ? [`"${n.name}" needs ${absent.map((d) => `"${d}"`).join(", ")}`] : [];
  });
  if (unmet.length > 0)
    throw new Error(`orchestrate: nodes depend on nodes it was not given: ${unmet.join("; ")}`);
  const state = new ExecState<Meta>(all);
  let processing = 0;
  let resumeLoop: () => void = () => {};
  const wake = () => resumeLoop();
  signal?.addEventListener("abort", wake, { once: true });
  let listenerError: { thrown: unknown } | undefined;
  const emit = (event: ExecEvent<Meta>) => {
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
  /** The grant each miss waiting for its slot awaits. */
  const slots = new Map<string, { resolve: () => void; reject: (reason: unknown) => void }>();

  const meta = (node: Node<Meta>) => (node.meta === undefined ? {} : { meta: node.meta });
  const settle = (node: Node<Meta>, result: Result) => {
    state.settle(node, result);
    emit({ type: "result", node: node.name, ...meta(node), result });
    releasePlace(node.name);
    wake();
  };

  // Once cancelled, every node that becomes ready settles cancelled instead of running, and every
  // miss waiting for its slot stops waiting, so the loop drains as running nodes settle.
  const drainCancelled = () => {
    let next: Ready<Meta> | null;
    while ((next = state.take())) {
      if (next.acquiring) slots.get(next.node.name)?.reject(signal?.reason);
      else settle(next.node, { name: next.node.name, actionKey: "", status: "cancelled" });
    }
  };

  const acquireFor = (node: Node<Meta>) => {
    let gate: Promise<void> | undefined;
    const waitForSlot = () => {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (node.concurrencyGroup === undefined) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        slots.set(node.name, { resolve, reject });
        state.waitForSlot(node);
        releasePlace(node.name);
        wake();
      });
    };
    return () => (gate ??= waitForSlot());
  };

  const ctx: SchedulerContext<Meta> = {
    take(filter) {
      if (signal?.aborted) {
        drainCancelled();
        return null;
      }
      return state.take(filter);
    },
    run({ node, acquiring }) {
      if (acquiring) {
        const slot = slots.get(node.name);
        slots.delete(node.name);
        if (!slot) return Promise.resolve();
        const place = new Promise<void>((resolve) => places.set(node.name, resolve));
        slot.resolve();
        return place;
      }
      const place = new Promise<void>((resolve) => places.set(node.name, resolve));
      const dep = state.failedDep(node);
      if (dep !== undefined) {
        settle(node, { name: node.name, actionKey: "", status: "dep-failed", dep });
        return place;
      }
      emit({ type: "dispatch", node: node.name, ...meta(node) });
      processing++;
      void run(node, state.depEntries(node), acquireFor(node))
        .catch((e: unknown): Result => {
          if (signal?.aborted) return { name: node.name, actionKey: "", status: "cancelled" };
          return {
            name: node.name,
            actionKey: "",
            status: "failed",
            error: errorOf(e),
            elapsed: 0,
          };
        })
        .then((result) => {
          processing--;
          slots.delete(node.name);
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
