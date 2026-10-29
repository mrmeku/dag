import { sha256 } from "js-sha256";
import { normalize } from "pathe";
import type { CacheEntry, DagFs } from "./cache.ts";
import type { Outputs } from "./graph/index.ts";
import { isMissingFileError } from "./utils.ts";

/** What a cache entry keeps of its outputs' content: its own hash and each output's. */
export type EntryHashes = Pick<CacheEntry, "contentHash" | "outputHashes">;

/** Every path the outputs hold, in one list. */
export const collectPaths = (outputs: Outputs): string[] => Object.values(outputs).flat();

/** The same outputs with each path passed through `f`. */
export function mapPaths<T>(outputs: Outputs, f: (path: string) => T): Record<string, T | T[]> {
  return Object.fromEntries(
    Object.entries(outputs).map(([name, v]) => [name, Array.isArray(v) ? v.map(f) : f(v)]),
  );
}

export type HashFileFn = DagFs["hashFile"];

/** SHA256 hex of in-memory content; the one hash every DagFs implementation should agree with. */
export function hashBytes(data: string | Uint8Array): string {
  return sha256.hex(data);
}

/** One input as keyed: a file's path and content hash, or a value's canonical JSON. */
export type KeyedInput = ["file", string, string] | ["value", string];
/**
 * One dep role as keyed: the hash of each output it reads, by name (`null` for one the dep did not
 * produce), or the mark for missing.
 */
export type KeyedDep = ["outputs", [string, string | null][]] | ["missing"];

/**
 * The action key: SHA256 of the action's kind, each input by name and each dep by role, both
 * sorted. Nothing else joins it: not the node's name or its deps' names, its meta or its
 * how-to-run fields.
 */
export function computeActionKey(
  kind: string,
  inputs: Record<string, KeyedInput>,
  deps: Record<string, KeyedDep>,
): string {
  const sorted = <T>(record: Record<string, T>) =>
    Object.keys(record)
      .sort()
      .map((k) => [k, record[k]]);
  return sha256.hex(JSON.stringify([kind, sorted(inputs), sorted(deps)]));
}

/** A path as its output directory sees it: what follows `<keyDir>/<the attempt's directory>/`. */
function relativeTo(keyDir: string, path: string): string {
  const normal = normalize(path);
  if (!normal.startsWith(`${keyDir}/`)) return normal;
  const rest = normal.slice(keyDir.length + 1);
  return rest.slice(rest.indexOf("/") + 1);
}

/**
 * The hashes of a node's outputs: each output's own, which a dependent that reads it keys on, and
 * the content hash of them all. Each covers its outputs' names, each file's path relative to its
 * output directory, and each file's content. So which file an output names is part of it,
 * wherever the directory sits. A path with no file rejects, naming the output and its file.
 */
export async function hashOutputFiles(
  outputs: Outputs,
  hashFile: HashFileFn,
  keyDir: string,
): Promise<EntryHashes> {
  const files = async (paths: string[], name: string) => {
    const hashed: string[][] = [];
    for (const path of paths) {
      const file = relativeTo(keyDir, path);
      try {
        hashed.push([file, await hashFile(path)]);
      } catch (e) {
        if (!isMissingFileError(e)) throw e;
        throw new Error(
          `output "${name}" (${file}) was not written. ` +
            `Write it at \`\${outputDir}/${file}\` before the action returns.`,
        );
      }
    }
    return hashed;
  };
  const shape: [string, string[][]][] = [];
  for (const [name, value] of Object.entries(outputs).sort(([a], [b]) => (a < b ? -1 : 1)))
    shape.push([name, await files([value].flat(), name)]);
  return {
    contentHash: sha256.hex(JSON.stringify(shape)),
    outputHashes: Object.fromEntries(
      shape.map(([name, hashed]) => [name, sha256.hex(JSON.stringify(hashed))]),
    ),
  };
}

/** Whether an entry's files still exist and hash to its content hash and output hashes. */
export async function verifyOutputs(
  entry: CacheEntry,
  hashFile: HashFileFn,
  keyDir: string,
): Promise<boolean> {
  try {
    const { contentHash, outputHashes } = await hashOutputFiles(entry.outputs, hashFile, keyDir);
    const sorted = (hashes: Record<string, string>) =>
      JSON.stringify(Object.entries(hashes).sort());
    return contentHash === entry.contentHash && sorted(outputHashes) === sorted(entry.outputHashes);
  } catch {
    return false;
  }
}
