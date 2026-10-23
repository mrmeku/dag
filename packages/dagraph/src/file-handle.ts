import type { DagFs } from "./cache.ts";
import { hashBytes } from "./content-addressing.ts";
import { FILE_HANDLE, notAString, type FileHandle } from "./graph/types.ts";

/** The handle of the file at `path`, which reads it through `fs`. */
export function fileHandle(fs: DagFs, path: string): FileHandle {
  const absolute = fs.resolve(path);
  const hash = () => fs.hashFile(absolute);
  // A byte that is not UTF-8 reads as U+FFFD, so text that holds one may have lost bytes.
  const readText = async () => {
    const text = await fs.readText(absolute);
    if (!text.includes("\uFFFD") || hashBytes(text) === (await hash())) return text;
    throw new Error(
      `${absolute} is not UTF-8 text: decoding it lost bytes. Hash its bytes with hash().`,
    );
  };
  return notAString(
    {
      [FILE_HANDLE]: true as const,
      path: absolute,
      text: readText,
      json: async <T>(is: (value: unknown) => value is T): Promise<T> => {
        const text = await readText();
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
      hash,
    },
    `the handle on ${absolute} can't be part of a string. Use its .path.`,
  );
}
