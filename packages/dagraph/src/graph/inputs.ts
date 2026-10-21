import type { CacheEntry } from "../cache.ts";
import { errorMessage } from "../utils.ts";
import {
  isFileInput,
  isOutputRef,
  type InputRecord,
  type OutputRef,
  type SettledOutputRef,
} from "./types.ts";

const isPlainObject = (value: object) => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
};

/**
 * A copy of a value input, `undefined` properties dropped. Its type is checked already; what no
 * type sees is refused by its path: `NaN`, `Infinity`, and an object that is not plain.
 */
function jsonValue(value: unknown, path: string): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${path} is ${value}`);
  if (Array.isArray(value)) return value.map((item, i) => jsonValue(item, `${path}[${i}]`));
  if (typeof value !== "object" || value === null || isOutputRef(value)) return value;
  if (!isPlainObject(value))
    throw new Error(`${path} is a ${value.constructor?.name ?? "class instance"}`);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, jsonValue(v, `${path}.${k}`)]),
  );
}

/**
 * Inputs as declared, or as their function returns them, checked for what their type cannot
 * see. Returns a copy, so a later change to the caller's object keys nothing.
 */
export function checkInputs(
  inputs: InputRecord<unknown> | undefined | (() => InputRecord<unknown> | undefined),
  where: string,
): Record<string, unknown> {
  try {
    return Object.fromEntries(
      Object.entries((typeof inputs === "function" ? inputs() : inputs) ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([name, v]) => [name, isFileInput(v) ? v : jsonValue(v, `inputs.${name}`)]),
    );
  } catch (e) {
    throw new Error(`${where}: ${errorMessage(e)}`);
  }
}

/** A value as JSON with sorted keys, each output ref as `#ref(...)`, which no JSON value spells. */
export function canonical(
  value: unknown,
  refKey: (ref: OutputRef | SettledOutputRef) => string,
): string {
  if (isOutputRef(value)) return `#ref(${refKey(value)})`;
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, refKey)).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, refKey)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** A value as the action reads it: each output ref replaced by its dep's published files' handles. */
export function resolveValue(
  value: unknown,
  depEntries: Record<string, CacheEntry>,
  handle: (path: string) => unknown,
): unknown {
  if (isOutputRef(value)) {
    const entry = depEntries[value.node];
    if (entry === undefined) return undefined;
    const outputs = entry.outputs;
    const paths =
      typeof outputs === "object" && !Array.isArray(outputs) ? outputs[value.output] : undefined;
    if (paths === undefined) throw new Error(`"${value.node}" has no output "${value.output}"`);
    return Array.isArray(paths) ? paths.map(handle) : handle(paths);
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, depEntries, handle));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveValue(v, depEntries, handle)]),
    );
  return value;
}
