import { isPlainObject } from "../json/index.ts";
import {
  isFileInput,
  isIdentifier,
  isInputList,
  isOutputRef,
  type AnyOutputRef,
  type InputRecord,
  type InputValue,
} from "./types.ts";

/**
 * A copy of a value input, `undefined` properties dropped. Its type is checked already; what no
 * type sees is refused by its path: `NaN`, `Infinity`, an object that is not plain, and a value
 * that a narrower type hides: a function, a symbol, a bigint, and `undefined` in a list.
 */
function jsonValue(value: unknown, path: string): InputValue<unknown> {
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value))
        throw new Error(`${path} is ${value}, which is not JSON. Give a finite number, or null.`);
      return value;
    case "undefined":
      throw new Error(`${path} is undefined, which is not JSON in a list. Give null, or no item.`);
    case "bigint":
      throw new Error(`${path} is a bigint, which is not JSON. Give a string: String(n).`);
    case "symbol":
      throw new Error(`${path} is a symbol, which is not JSON. Give a string.`);
    case "function":
      throw new Error(
        `${path} is a function, which is not JSON. Give the data it holds, as a record.`,
      );
    case "object":
      return value === null || isOutputRef(value) ? value : jsonObject(value, path);
  }
}

function jsonObject(value: object, path: string): InputValue<unknown> {
  if (Array.isArray(value)) return value.map((item, i) => jsonValue(item, `${path}[${i}]`));
  if (!isPlainObject(value)) {
    const name = path.slice(path.lastIndexOf(".") + 1);
    // The types give every object a constructor; Object.create can make one without.
    const type: unknown = value.constructor;
    const className = typeof type === "function" && type.name ? type.name : "class instance";
    throw new Error(
      `${path} is a ${className}, which is not JSON. Give a ` +
        `plain object of its fields${isIdentifier(name) ? `: { ...${name} }` : ""}.`,
    );
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, jsonValue(v, `${path}.${k}`)]),
  );
}

/**
 * Inputs as declared, or as their function returns them, checked for what their type cannot
 * see. Returns a copy, as the key reads it: a later change to the caller's object keys nothing.
 */
export function checkInputs(
  inputs: InputRecord<unknown> | undefined | (() => InputRecord<unknown> | undefined),
  where: string,
): InputRecord<unknown> {
  try {
    return Object.fromEntries(
      Object.entries((typeof inputs === "function" ? inputs() : inputs) ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([name, v]) => [name, isFileInput(v) ? v : jsonValue(v, `inputs.${name}`)]),
    );
  } catch (e) {
    throw new Error(`${where}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** A value as JSON with sorted keys, each output ref as `#ref(...)`, which no JSON value spells. */
export function canonical(
  value: InputValue<unknown> | undefined,
  refKey: (ref: AnyOutputRef) => string,
): string {
  if (isOutputRef(value)) return `#ref(${refKey(value)})`;
  if (isInputList(value)) return `[${value.map((v) => canonical(v, refKey)).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v, refKey)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
