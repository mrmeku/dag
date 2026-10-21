import type { DagFs } from "./cache.ts";
import { FILE_HANDLE } from "./graph/types.ts";

/**
 * The handle of the file at `path`, which reads it through `fs`. Its type is FileHandle without
 * the brand, which no object has: the action reads it through its own context's types, which the
 * graph erased (define-action.ts).
 */
export function fileHandle(fs: DagFs, path: string) {
  const absolute = fs.resolve(path);
  const refuse = (): never => {
    throw new TypeError(
      `The handle of ${absolute} is not a string. Pass its path, or read it with text() or json().`,
    );
  };
  return {
    [FILE_HANDLE]: true,
    path: absolute,
    text: () => fs.readText(absolute),
    json: async <T>(is: (value: unknown) => value is T): Promise<T> => {
      const text = await fs.readText(absolute);
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (e) {
        throw new Error(`${absolute} holds no JSON`, { cause: e });
      }
      if (!is(value))
        throw new Error(`${absolute} holds JSON that ${is.name || "its guard"} refuses`);
      return value;
    },
    toString: refuse,
    valueOf: refuse,
    toJSON: refuse,
    [Symbol.toPrimitive]: refuse,
  };
}
