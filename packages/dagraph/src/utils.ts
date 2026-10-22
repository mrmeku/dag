import type { FailedError, JsonValue } from "./types.ts";

/** A thrown value's message: an error's own, anything else as text. */
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Whether `object` is a plain record: a class instance, an array or a `Map` is not. */
export const isPlainObject = (object: object) => {
  const proto: unknown = Object.getPrototypeOf(object);
  return proto === null || Object.getPrototypeOf(proto) === null;
};

/**
 * A copy of `value` as JSON, built from the values it checks: an `undefined` property is left out
 * and `-0` is `0`. `undefined` when it is not JSON: a cycle, `NaN`, `Infinity` and a class
 * instance are not, nor is an array with an `undefined` item or a hole.
 */
function jsonCopy(value: unknown, within: readonly object[] = []): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? (value === 0 ? 0 : value) : undefined;
  if (typeof value !== "object" || within.includes(value)) return undefined;
  const inner = [...within, value];
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const copy = jsonCopy(item, inner);
      if (copy === undefined) return undefined;
      items.push(copy);
    }
    return items;
  }
  if (!isPlainObject(value)) return undefined;
  const entries: [string, JsonValue][] = [];
  for (const [key, v] of Object.entries(value)) {
    if (v === undefined) continue;
    const copy = jsonCopy(v, inner);
    if (copy === undefined) return undefined;
    entries.push([key, copy]);
  }
  return Object.fromEntries(entries);
}

/** Whether `value` is JSON: a cycle, `NaN`, `Infinity` and a class instance are not. */
export const isJsonValue = (value: unknown): value is JsonValue => jsonCopy(value) !== undefined;

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
 * A thrown value as a result's error: its name, its message and its cause as JSON. A cause that
 * throws as it is read, from a getter or a proxy, is dropped.
 */
export function errorOf(e: unknown, message = errorMessage(e)): FailedError {
  let cause: JsonValue | undefined;
  try {
    cause = e instanceof Error ? jsonCause(e.cause, [e]) : undefined;
  } catch {
    cause = undefined;
  }
  return {
    name: e instanceof Error ? e.name : "Error",
    message,
    ...(cause !== undefined && { cause }),
  };
}
