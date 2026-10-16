import type { Node, Outputs } from "./graph/index.ts";

/** Discriminated union of per-node outcomes after DAG execution. */
export type ExecResult = { name: string; actionKey: string } & (
  | { status: "done"; outputs: Outputs; contentHash: string }
  | { status: "cached"; outputs: Outputs; contentHash: string }
  /** A node whose `timeoutMs` elapsed fails with an error named "TimeoutError". */
  | { status: "fail"; error: Error }
  | { status: "dep-failed"; error: Error }
  /**
   * The execution was cancelled before the node finished: while it waited (`actionKey` is "")
   * or while its action ran. Either way it produced nothing and nothing was cached.
   */
  | { status: "cancelled" }
);

export interface Tally {
  done: number;
  cached: number;
  fail: number;
  depFailed: number;
  cancelled: number;
}

/** Count results by status. */
export function tally(results: Iterable<ExecResult>): Tally {
  const t: Tally = { done: 0, cached: 0, fail: 0, depFailed: 0, cancelled: 0 };
  for (const r of results) {
    if (r.status === "dep-failed") t.depFailed++;
    else t[r.status]++;
  }
  return t;
}

/** Result of processing a single node — returned by `processNode`. */
type ProcessNodeResultBase = { name: string; actionKey: string };
export type ProcessNodeResult = ProcessNodeResultBase &
  (
    | { status: "done"; outputs: Outputs; contentHash: string; elapsed: number }
    | { status: "cached"; outputs: Outputs; contentHash: string }
    /** `cause` is the thrown error's, as is; a RunNode that carries results across processes serializes it or drops it. */
    | { status: "fail"; error: string; elapsed: number; timedOut?: true; cause?: unknown }
    | { status: "dep-failed"; error: string }
    /** `actionKey` is "" when the action never started. */
    | { status: "cancelled" }
  );

/** Events dispatched during DAG execution — consumed by ExecState and optionally by progress UIs. */
export type ExecEvent =
  /** The scheduler handed the node to a runner. Fires before the cache is consulted. */
  | { type: "dispatch"; node: Node }
  /** The node's action is about to run: a cache miss. Cached nodes never start. */
  | { type: "start"; node: Node }
  | { type: "settled"; node: Node }
  | { type: "cached"; node: Node; actionKey: string; outputs: Outputs; contentHash: string }
  | {
      type: "done";
      node: Node;
      actionKey: string;
      outputs: Outputs;
      contentHash: string;
      elapsed: number;
    }
  | { type: "fail"; node: Node; actionKey: string; error: unknown; elapsed: number }
  | { type: "dep-failed"; node: Node; error: unknown }
  /** `actionKey` is "" when the node never started. */
  | { type: "cancelled"; node: Node; actionKey: string };
