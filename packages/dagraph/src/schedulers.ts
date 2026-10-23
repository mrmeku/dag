import type { Ready } from "./exec-state.ts";
import type { Scheduler, SchedulerContext } from "./orchestrate.ts";

/**
 * Core scheduling loop: repeatedly take ready nodes, run them, and wait for in-flight work to
 * complete. Hooks allow filtering (for limits) and bookkeeping (for counters).
 */
function schedulingLoop(hooks?: {
  admits?: (ready: Ready) => boolean;
  onRun?: (ready: Ready) => void;
  onEnd?: (ready: Ready) => void;
}): Scheduler {
  return async <Meta>(ctx: SchedulerContext<Meta>) => {
    // A settled node resumes the loop before its onEnd runs, so the loop may see a stale filter.
    // onEnd dispatches too: whichever of the two runs last sees both updates.
    const dispatch = () => {
      let next: Ready<Meta> | null;
      while ((next = ctx.take(hooks?.admits))) {
        const taken = next;
        hooks?.onRun?.(taken);
        void ctx.run(taken).then(() => {
          hooks?.onEnd?.(taken);
          dispatch();
        });
      }
    };
    while (ctx.hasWork()) {
      dispatch();
      await ctx.workAvailable();
    }
  };
}

/** Scheduler with no limits: admits every ready node at once. This is the default. */
export function unboundedScheduler(): Scheduler {
  return schedulingLoop();
}

export interface ThrottledSchedulerOptions {
  /** The most nodes processed at once, as Ninja's `-j`. */
  maxParallelism?: number;
  /** For each concurrency group, the most of its actions that run at once; a hit takes no slot. */
  concurrencyLimits?: Record<string, number>;
}

/**
 * Scheduler with a global limit and one per concurrency group, as Ninja's pools. A node holds its
 * place from being handed to processing until it settles. A miss in a group gives its place back
 * while it waits for the group's slot, and takes both once both are free.
 */
export function throttledScheduler(opts?: ThrottledSchedulerOptions): Scheduler {
  const { maxParallelism = Infinity, concurrencyLimits = {} } = opts ?? {};
  const checkLimit = (field: string, limit: number) => {
    if (limit !== Infinity && !(Number.isInteger(limit) && limit >= 1))
      throw new RangeError(
        `throttledScheduler: ${field} must be a whole number from 1, or Infinity, got ${limit}`,
      );
  };
  checkLimit("maxParallelism", maxParallelism);
  for (const [group, limit] of Object.entries(concurrencyLimits))
    checkLimit(`concurrencyLimits.${group}`, limit);
  if (opts?.maxParallelism == null && opts?.concurrencyLimits == null) return unboundedScheduler();

  let inflight = 0;
  const groupInflight = new Map<string, number>();
  const count = ({ node, acquiring }: Ready, delta: number) => {
    inflight += delta;
    const group = node.concurrencyGroup;
    if (acquiring && group) groupInflight.set(group, (groupInflight.get(group) ?? 0) + delta);
  };

  return schedulingLoop({
    admits({ node, acquiring }) {
      if (inflight >= maxParallelism) return false;
      const group = node.concurrencyGroup;
      if (!acquiring || !group) return true;
      return (groupInflight.get(group) ?? 0) < (concurrencyLimits[group] ?? Infinity);
    },
    onRun: (ready) => count(ready, 1),
    onEnd: (ready) => count(ready, -1),
  });
}
