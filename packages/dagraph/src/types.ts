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
 * How one node settled. `actionKey` is "" when it never got one. `elapsed` is there only when the
 * engine ran the action. A result is plain data, to write to a file or send to another process as
 * it is. The engine copies a failure's cause when it is JSON. It changes an `Error` to its name,
 * message and cause, converted the same way. It drops anything else.
 */
export type Result = { name: string; actionKey: string } & (
  | (CacheEntry & { status: "done"; elapsed: number })
  | (CacheEntry & { status: "cached" })
  /** `timedOut`, and `error.name` "TimeoutError", after the node's own timeout. */
  | {
      status: "failed";
      error: { name: string; message: string; cause?: JsonValue };
      elapsed?: number;
      timedOut?: true;
    }
  /** `dep` is a required dep that did not succeed; `rootCauses` are the failures behind it. */
  | { status: "dep-failed"; dep: string; rootCauses?: string[] }
  | { status: "cancelled"; elapsed?: number }
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
  const elapsedIfAny = hasElapsed || !("elapsed" in value);
  switch (value.status) {
    case "done":
      return isCacheEntry(value) && hasElapsed;
    case "cached":
      return isCacheEntry(value);
    case "failed":
      return (
        elapsedIfAny &&
        (!("timedOut" in value) || value.timedOut === true) &&
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
      return (
        "dep" in value &&
        typeof value.dep === "string" &&
        (!("rootCauses" in value) ||
          (Array.isArray(value.rootCauses) &&
            value.rootCauses.every((cause) => typeof cause === "string")))
      );
    default:
      return value.status === "cancelled" && elapsedIfAny;
  }
}

/** Whether the node succeeded: its result is `done` or `cached`. */
export function isSucceeded(result: Result): result is SucceededResult {
  return result.status === "done" || result.status === "cached";
}

export type Tally = Record<Result["status"], number>;

/** Where the engine reads the time: `Date`, or a fake one in a test. */
export type Clock = Pick<DateConstructor, "now">;

/** Count results, or anything else with a status, by status. */
export function countResultsByStatus(results: Iterable<Pick<Result, "status">>): Tally {
  const t: Tally = { done: 0, cached: 0, failed: 0, "dep-failed": 0, cancelled: 0 };
  for (const r of results) t[r.status]++;
  return t;
}

/**
 * One stream of what happens, each event naming its node, carrying its `meta` and when it
 * occurred. Orchestration
 * emits `dispatch`, as a node is handed to processing, `pending`, as a miss is held back before its
 * action runs, until the scheduler lets it run, and `result`. Processing emits `start`, on a miss as
 * the action begins, and `output`, for what the action prints.
 */
export type ExecEvent<Meta = unknown> = { node: string; meta?: Meta; occurredAt: number } & (
  | { type: "dispatch" }
  | { type: "pending" }
  | { type: "start" }
  | { type: "output"; chunk: string }
  | { type: "result"; result: Result }
);

/**
 * Receives each `ExecEvent`. For `start` it may return a promise, and the action runs only once it
 * resolves, so a journal records the start before any effect: `onEvent: (event) =>
 * journal.record(event)`. A rejection fails the node without running it. The promise of an `output`
 * is not awaited, and its rejection is dropped. That of a `dispatch` or a `result` that rejects
 * before the execution ends rejects it at its end, as a throw does.
 */
export type ExecListener<Meta = unknown> = (event: ExecEvent<Meta>) => unknown;
