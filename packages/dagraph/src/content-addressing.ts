import { sha256 } from "js-sha256";
import { join } from "pathe";
import type { CacheEntry, DagFs } from "./cache.ts";
import type { Outputs } from "./graph/index.ts";

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

/**
 * The hashes of a node's outputs, whose paths are relative to `outputDir`: each output's own,
 * which a dependent that reads it keys on, and the content hash of them all. Each covers its
 * outputs' names, each file's path and each file's content. So which file an output names is part
 * of it, wherever `outputDir` sits.
 */
export async function hashOutputFiles(
  outputs: Outputs,
  hashFile: HashFileFn,
  outputDir: string,
): Promise<EntryHashes> {
  const shape: [string, string[][]][] = [];
  for (const [name, value] of Object.entries(outputs).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const hashed: string[][] = [];
    for (const file of [value].flat()) hashed.push([file, await hashFile(join(outputDir, file))]);
    shape.push([name, hashed]);
  }
  return {
    contentHash: sha256.hex(JSON.stringify(shape)),
    outputHashes: Object.fromEntries(
      shape.map(([name, hashed]) => [name, sha256.hex(JSON.stringify(hashed))]),
    ),
  };
}

/**
 * Whether the files `entry` names, relative to `outputDir`, still exist and hash to its content
 * hash and output hashes.
 */
export async function verifyOutputs(
  entry: CacheEntry,
  hashFile: HashFileFn,
  outputDir: string,
): Promise<boolean> {
  try {
    const { contentHash, outputHashes } = await hashOutputFiles(entry.outputs, hashFile, outputDir);
    const sorted = (hashes: Record<string, string>) =>
      JSON.stringify(Object.entries(hashes).sort());
    return contentHash === entry.contentHash && sorted(outputHashes) === sorted(entry.outputHashes);
  } catch {
    return false;
  }
}
