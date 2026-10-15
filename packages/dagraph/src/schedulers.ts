import type { Node } from "./graph/index.ts";
import type { Scheduler, SchedulerContext } from "./orchestrate.ts";

/**
 * Core scheduling loop: repeatedly take ready nodes, run them, and wait for in-flight work to
 * complete. Hooks allow filtering (for concurrency limits) and bookkeeping (for counters).
 */
function schedulingLoop(hooks?: {
  filter?: (node: Node) => boolean;
  onStart?: (node: Node) => void;
  onEnd?: (node: Node) => void;
}): Scheduler {
  return async (ctx: SchedulerContext) => {
    // A settled node resumes the loop before its onEnd runs, so the loop may see a stale filter.
    // onEnd dispatches too: whichever of the two runs last sees both updates.
    const dispatch = () => {
      let node: Node | null;
      while ((node = ctx.take(hooks?.filter))) {
        const captured = node;
        hooks?.onStart?.(captured);
        ctx.run(captured).then(() => {
          hooks?.onEnd?.(captured);
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

/** Scheduler with no parallelism limits — runs all ready nodes immediately. */
export function unboundedScheduler(): Scheduler {
  return schedulingLoop();
}

export interface ThrottledSchedulerOptions {
  maxParallelism?: number;
  concurrencyLimits?: Record<string, number>;
}

/**
 * Scheduler with global and per-group concurrency limits. Nodes with a concurrencyGroup are
 * subject to the corresponding limit (e.g. { whisper: 1 } to serialize CPU-heavy transcription).
 */
export function throttledScheduler(opts?: ThrottledSchedulerOptions): Scheduler {
  const { maxParallelism, concurrencyLimits } = opts ?? {};
  if (maxParallelism == null && concurrencyLimits == null) return unboundedScheduler();

  let inflight = 0;
  const groupInflight = new Map<string, number>();

  return schedulingLoop({
    filter(node) {
      if (maxParallelism != null && inflight >= maxParallelism) return false;
      if (!concurrencyLimits) return true;
      const group = node.concurrencyGroup;
      if (!group) return true;
      const limit = concurrencyLimits[group];
      return limit == null || (groupInflight.get(group) ?? 0) < limit;
    },
    onStart(node) {
      inflight++;
      const group = node.concurrencyGroup;
      if (group) groupInflight.set(group, (groupInflight.get(group) ?? 0) + 1);
    },
    onEnd(node) {
      inflight--;
      const group = node.concurrencyGroup;
      if (group) groupInflight.set(group, (groupInflight.get(group) ?? 0) - 1);
    },
  });
}
