import { isCacheEntry, type CacheEntry } from "./cache.ts";
import { isJsonValue } from "./utils.ts";

/** A value as JSON holds it. A property that is `undefined` is left out when it is written. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

/**
 * How one node settled. `actionKey` is "" when it never got one. A result is plain data, to write
 * to a file or send to another process as it is. The engine copies a failure's cause when it is
 * JSON. It changes an `Error` to its name, message and cause, converted the same way. It drops
 * anything else.
 */
export type Result = { name: string; actionKey: string } & (
  | (CacheEntry & { status: "done"; elapsed: number })
  | (CacheEntry & { status: "cached" })
  /** `error.name` is "TimeoutError" after the node's own timeout. */
  | {
      status: "failed";
      error: { name: string; message: string; cause?: JsonValue };
      elapsed: number;
    }
  /** `dep` is a required dep that did not succeed. */
  | { status: "dep-failed"; dep: string }
  | { status: "cancelled" }
);

/** The result of a node that succeeded, `done` or `cached`: it carries the node's entry. */
export type SucceededResult = Extract<Result, { status: "done" | "cached" }>;

/** The error of a `failed` result. */
export type FailedError = Extract<Result, { status: "failed" }>["error"];

/** Whether `value` is a `Result`: the guard for one read back from a file or another process. */
export function isResult(value: unknown): value is Result {
  if (typeof value !== "object" || value === null || !("status" in value)) return false;
  if (!("name" in value && typeof value.name === "string")) return false;
  if (!("actionKey" in value && typeof value.actionKey === "string")) return false;
  const hasElapsed = "elapsed" in value && typeof value.elapsed === "number";
  switch (value.status) {
    case "done":
      return isCacheEntry(value) && hasElapsed;
    case "cached":
      return isCacheEntry(value);
    case "failed":
      return (
        hasElapsed &&
        "error" in value &&
        typeof value.error === "object" &&
        value.error !== null &&
        "name" in value.error &&
        typeof value.error.name === "string" &&
        "message" in value.error &&
        typeof value.error.message === "string" &&
        (!("cause" in value.error) || isJsonValue(value.error.cause))
      );
    case "dep-failed":
      return "dep" in value && typeof value.dep === "string";
    default:
      return value.status === "cancelled";
  }
}

/** Whether the node succeeded: its result is `done` or `cached`. */
export function isSucceeded(result: Result): result is SucceededResult {
  return result.status === "done" || result.status === "cached";
}

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
