import { hashBytes, type CacheEntry, type FileSystem } from "../cache/index.ts";
import {
  FILE_HANDLE,
  isInputList,
  isOutputRef,
  notAString,
  type FileHandle,
  type InputValue,
  type Resolved,
} from "../graph/index.ts";

/** The handle of the file at `path`, which reads it through `fs`. */
export function fileHandle(fs: FileSystem, path: string): FileHandle {
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

/** A value input as the action reads it: each output ref replaced by its dep's committed files' handles. */
export function resolveValue(
  value: InputValue<unknown> | undefined,
  depEntries: Record<string, CacheEntry>,
  handle: (path: string) => FileHandle,
): Resolved<InputValue<unknown> | undefined> {
  if (isOutputRef(value)) {
    const entry = depEntries[value.node];
    if (entry === undefined) return undefined;
    const paths = entry.outputs[value.output];
    if (paths === undefined) throw new Error(`"${value.node}" has no output "${value.output}"`);
    return Array.isArray(paths) ? paths.map(handle) : handle(paths);
  }
  if (isInputList(value)) return value.map((v) => resolveValue(v, depEntries, handle));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveValue(v, depEntries, handle)]),
    );
  return value;
}
