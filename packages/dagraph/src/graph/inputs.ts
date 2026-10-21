import type { CacheEntry } from "../cache.ts";
import { errorMessage } from "../utils.ts";
import { isFileInput, isNodeRef, isOutputRef, type OutputRef } from "./types.ts";

const isPlainObject = (value: object) => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
};

function kindOf(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value !== "object" || value === null) return `a ${typeof value}`;
  return `a ${value.constructor?.name ?? "class instance"}`;
}

/** A copy of a JSON value, `undefined` properties dropped; anything else is refused by its path. */
function jsonValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (isOutputRef(value)) return value;
  if (isFileInput(value)) throw new Error(`${path} is a file(); a file is a whole input`);
  if (isNodeRef(value))
    throw new Error(`${path} is a node; what comes from a node is a dep, declared in deps`);
  if (Array.isArray(value))
    return value.map((item, i) => {
      if (item === undefined) throw new Error(`${path}[${i}] is undefined`);
      return jsonValue(item, `${path}[${i}]`);
    });
  if (typeof value === "object" && isPlainObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, jsonValue(v, `${path}.${k}`)]),
    );
  throw new Error(`${path} is ${kindOf(value)}`);
}

/**
 * Inputs as declared, checked: a record whose entries are each `file(path)` or a JSON value,
 * which may hold output refs. Returns a copy, so a later change to the caller's object keys nothing.
 */
export function checkInputs(inputs: unknown, where: string): Record<string, unknown> {
  if (inputs === undefined) return {};
  try {
    if (Array.isArray(inputs) || typeof inputs !== "object" || inputs === null)
      throw new Error(
        `inputs is ${Array.isArray(inputs) ? "a list" : kindOf(inputs)}; inputs are a record of named inputs, each file(path) or a JSON value`,
      );
    return Object.fromEntries(
      Object.entries(inputs)
        .filter(([, v]) => v !== undefined)
        .map(([name, v]) => [name, isFileInput(v) ? v : jsonValue(v, `inputs.${name}`)]),
    );
  } catch (e) {
    throw new Error(`${where}: ${errorMessage(e)}`);
  }
}

export function outputRefsIn(value: unknown): OutputRef[] {
  if (isOutputRef(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(outputRefsIn);
  if (typeof value === "object" && value !== null)
    return Object.values(value).flatMap(outputRefsIn);
  return [];
}

/** A value as JSON with sorted keys, each output ref as `#ref(...)`, which no JSON value spells. */
export function canonical(value: unknown, refKey: (ref: OutputRef) => string): string {
  if (isOutputRef(value)) return `#ref(${refKey(value)})`;
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, refKey)).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, refKey)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** A value as the action reads it: each output ref replaced by its dep's published paths. */
export function resolveValue(value: unknown, depEntries: Record<string, CacheEntry>): unknown {
  if (isOutputRef(value)) {
    const entry = depEntries[value.node];
    if (entry === undefined) return undefined;
    const outputs = entry.outputs;
    if (typeof outputs !== "object" || Array.isArray(outputs) || !(value.output in outputs))
      throw new Error(`"${value.node}" has no output "${value.output}"`);
    return outputs[value.output];
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, depEntries));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveValue(v, depEntries)]),
    );
  return value;
}
