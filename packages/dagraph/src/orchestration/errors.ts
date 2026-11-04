import { jsonCopy, type JsonValue } from "../json/index.ts";
import type { FailureError } from "./types.ts";

/** A thrown value's message: an error's own, anything else as text. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * A thrown error's cause as JSON. JSON is copied. An `Error` becomes its name, its message and its
 * own cause, converted the same way. Anything else is dropped, and so is an error that comes
 * again in the chain.
 */
function jsonCause(cause: unknown, within: readonly Error[]): JsonValue | undefined {
  if (!(cause instanceof Error)) return jsonCopy(cause);
  if (within.includes(cause)) return undefined;
  const inner = jsonCause(cause.cause, [...within, cause]);
  return { name: cause.name, message: cause.message, ...(inner !== undefined && { cause: inner }) };
}

/**
 * The `error` of a failed result, made from what a `RunNode` or an action threw: its name, its
 * message and its cause as JSON, so the result stays plain data. Orchestration and lookup-or-run
 * call it as they settle a node `failed`. A cause that throws as it is read, from a getter or a
 * proxy, is dropped.
 */
export function failureErrorOf(thrown: unknown, message = errorMessage(thrown)): FailureError {
  let cause: JsonValue | undefined;
  try {
    cause = thrown instanceof Error ? jsonCause(thrown.cause, [thrown]) : undefined;
  } catch {
    cause = undefined;
  }
  return {
    name: thrown instanceof Error ? thrown.name : "Error",
    message,
    ...(cause !== undefined && { cause }),
  };
}
