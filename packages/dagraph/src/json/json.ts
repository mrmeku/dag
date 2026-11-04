/** A value as JSON holds it. A property that is `undefined` is left out when it is written. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue | undefined };

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
export function jsonCopy(value: unknown, within: readonly object[] = []): JsonValue | undefined {
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
