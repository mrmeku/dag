import type { DagFs } from "./cache.ts";
import { FILE_HANDLE, notAString, type FileHandle } from "./graph/types.ts";

/** The handle of the file at `path`, which reads it through `fs`. */
export function fileHandle(fs: DagFs, path: string): FileHandle {
  const absolute = fs.resolve(path);
  return notAString(
    {
      [FILE_HANDLE]: true as const,
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
    },
    `the handle on ${absolute} can't be part of a string. Use its .path.`,
  );
}
