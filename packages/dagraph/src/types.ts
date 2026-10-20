import type { Outputs } from "./graph/index.ts";

/**
 * How one node settled. `actionKey` is "" when it never got one. A result is plain data, except
 * `error.cause`, the thrown value as is: an executor that carries a result across processes
 * serializes it or drops it.
 */
export type Result = { name: string; actionKey: string } & (
  | { status: "done"; outputs: Outputs; contentHash: string; elapsed: number }
  | { status: "cached"; outputs: Outputs; contentHash: string }
  /** `error.name` is "TimeoutError" after the node's own timeout. */
  | { status: "failed"; error: { name: string; message: string; cause?: unknown }; elapsed: number }
  /** `dep` is a required dep that did not succeed. */
  | { status: "dep-failed"; dep: string }
  | { status: "cancelled" }
);

export type Tally = Record<Result["status"], number>;

/** Count results by status. */
export function tally(results: Iterable<Result>): Tally {
  const t: Tally = { done: 0, cached: 0, failed: 0, "dep-failed": 0, cancelled: 0 };
  for (const r of results) t[r.status]++;
  return t;
}

/**
 * One stream of what happens, each event naming its node and carrying its `meta`. Orchestration
 * emits `dispatch`, as a node is handed to processing, and `result`. Processing emits `start`, on
 * a miss as the action begins, and `output`, for what the action prints.
 */
export type ExecEvent<Meta = unknown> = { node: string; meta?: Meta } & (
  | { type: "dispatch" }
  | { type: "start" }
  | { type: "output"; chunk: string }
  | { type: "result"; result: Result }
);
