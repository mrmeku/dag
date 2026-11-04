import { isJsonValue, type JsonValue } from "../json/index.ts";

/**
 * A node as orchestration schedules it: its name, its deps and its concurrency group. Its `meta`
 * is the caller's, carried through to events untouched.
 */
export interface ScheduledNode<Meta = unknown> {
  name: string;
  /** The names of the nodes it depends on, once each. */
  deps: string[];
  /** The deps it runs without when they do not succeed. */
  settledDeps?: string[];
  concurrencyGroup?: string;
  meta?: Meta;
}

/** The deps a node runs only once they succeed: its deps less its `settled` ones. */
export function requiredDeps(node: ScheduledNode): string[] {
  return node.deps.filter((d) => !node.settledDeps?.includes(d));
}

/** A thrown value as a result keeps it: its name, its message and its cause as JSON. */
export type FailureError = { name: string; message: string; cause?: JsonValue };

/**
 * How one node settled. `details` is what a node that succeeded made. Details are what whatever
 * ran the node reports after a failure or a cancel, passed on untouched; orchestration builds no
 * details of its own. A result is plain data, to write to a file or send to another process as it
 * is. The engine copies a failure's cause when it is JSON. It changes an `Error` to its name,
 * message and cause, converted the same way. It drops anything else.
 */
export type Result<SuccessDetails, FailureDetails, CancellationDetails> = { name: string } & (
  | { status: "succeeded"; details: SuccessDetails }
  | { status: "failed"; error: FailureError; details?: FailureDetails }
  | { status: "cancelled"; details?: CancellationDetails }
  /** `dep` is a required dep that did not succeed; `rootCauses` are the failures behind it. */
  | { status: "dep-failed"; dep: string; rootCauses?: string[] }
);

const isFailureError = (value: unknown): value is FailureError =>
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  typeof value.name === "string" &&
  "message" in value &&
  typeof value.message === "string" &&
  (!("cause" in value) || isJsonValue(value.cause));

/**
 * Whether `value` is a `Result` whose details pass their guards: the guard for one
 * read back from a file or another process.
 */
export function isResult<SuccessDetails, FailureDetails, CancellationDetails>(
  value: unknown,
  isSuccessDetails: (value: unknown) => value is SuccessDetails,
  isFailureDetails: (value: unknown) => value is FailureDetails,
  isCancellationDetails: (value: unknown) => value is CancellationDetails,
): value is Result<SuccessDetails, FailureDetails, CancellationDetails> {
  if (typeof value !== "object" || value === null || !("status" in value)) return false;
  if (!("name" in value && typeof value.name === "string")) return false;
  switch (value.status) {
    case "succeeded":
      return "details" in value && isSuccessDetails(value.details);
    case "failed":
      return (
        "error" in value &&
        isFailureError(value.error) &&
        (!("details" in value) || isFailureDetails(value.details))
      );
    case "cancelled":
      return !("details" in value) || isCancellationDetails(value.details);
    case "dep-failed":
      return (
        "dep" in value &&
        typeof value.dep === "string" &&
        (!("rootCauses" in value) ||
          (Array.isArray(value.rootCauses) &&
            value.rootCauses.every((cause) => typeof cause === "string")))
      );
    default:
      return false;
  }
}

/** Whether the node succeeded: its result carries its details. */
export function isSucceeded<Settled extends Result<unknown, unknown, unknown>>(
  result: Settled,
): result is Extract<Settled, { status: "succeeded" }> {
  return result.status === "succeeded";
}

export type Tally = Record<Result<unknown, unknown, unknown>["status"], number>;

/** Count results, or anything else with a status, by status. */
export function countResultsByStatus(results: Iterable<{ status: keyof Tally }>): Tally {
  const t: Tally = { succeeded: 0, failed: 0, cancelled: 0, "dep-failed": 0 };
  for (const r of results) t[r.status]++;
  return t;
}

/**
 * Orchestration's stream of what happens, each event naming its node, carrying its `meta` and
 * when it occurred: `dispatch`, as a node is handed to whatever runs it, `pending`, as a node
 * waiting for its slot is held back until the scheduler lets it run, and `result`.
 */
export type OrchestrationEvent<Meta, SuccessDetails, FailureDetails, CancellationDetails> = {
  node: string;
  meta?: Meta;
  occurredAt: number;
} & (
  | { type: "dispatch" }
  | { type: "pending" }
  | { type: "result"; result: Result<SuccessDetails, FailureDetails, CancellationDetails> }
);
