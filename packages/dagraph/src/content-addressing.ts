import { sha256 } from "js-sha256";
import { normalize } from "pathe";
import type { CacheEntry } from "./cache.ts";
import type { Outputs } from "./graph/index.ts";

/** Flatten an Outputs value (string, array, or record) into a flat list of file paths. */
export function collectPaths(outputs: Outputs): string[] {
  if (typeof outputs === "string") return [outputs];
  if (Array.isArray(outputs)) return outputs;
  return Object.values(outputs).flatMap((v) => (Array.isArray(v) ? v : [v]));
}

export type HashFileFn = (path: string) => Promise<string>;

/** SHA256 hex of in-memory content; the one hash every DagFs implementation should agree with. */
export function hashBytes(data: string | Uint8Array): string {
  return sha256.hex(data);
}

/** Per-execution memo for input file hashes, so many nodes declaring one file hash it once. */
export type InputHashMemo = Map<string, Promise<string>>;

export function hashInput(path: string, hashFile: HashFileFn, memo: InputHashMemo) {
  let pending = memo.get(path);
  if (!pending) {
    pending = hashFile(path);
    memo.set(path, pending);
  }
  return pending;
}

/** One input as keyed: a file's path and content hash, or a value's canonical JSON. */
export type KeyedInput = ["file", string, string] | ["value", string];
/** One dep role as keyed: its content hash, its fingerprint's hash, or the mark for missing. */
export type KeyedDep = ["content", string] | ["fingerprint", string] | ["missing"];

/**
 * The action key: SHA256 of each input by name and each dep by role, both sorted. Nothing else
 * joins it: not the node's name or its deps' names, its kind, its meta or its how-to-run fields.
 */
export function computeActionKey(
  inputs: Record<string, KeyedInput>,
  deps: Record<string, KeyedDep>,
): string {
  const sorted = <T>(record: Record<string, T>) =>
    Object.keys(record)
      .sort()
      .map((k) => [k, record[k]]);
  return sha256.hex(JSON.stringify([sorted(inputs), sorted(deps)]));
}

/** A path as its output directory sees it: what follows `<keyDir>/<the attempt's directory>/`. */
function relativeTo(keyDir: string, path: string): string {
  const normal = normalize(path);
  if (!normal.startsWith(`${keyDir}/`)) return normal;
  const rest = normal.slice(keyDir.length + 1);
  return rest.slice(rest.indexOf("/") + 1);
}

/**
 * A hash of a node's outputs, early cutoff compares it and dependents key on it: each output's
 * name, each file's path relative to its output directory, and each file's content. So which
 * file an output names is part of it, wherever the directory sits.
 */
export async function hashOutputFiles(
  outputs: Outputs,
  hashFile: HashFileFn,
  keyDir: string,
): Promise<string> {
  const files = async (paths: string[]) => {
    const hashed: string[][] = [];
    for (const path of paths) hashed.push([relativeTo(keyDir, path), await hashFile(path)]);
    return hashed;
  };
  const shape: unknown[] = [];
  if (typeof outputs === "string") shape.push(...(await files([outputs])));
  else if (Array.isArray(outputs)) shape.push(await files(outputs));
  else
    for (const name of Object.keys(outputs).sort()) {
      const value = outputs[name]!;
      shape.push([name, Array.isArray(value) ? await files(value) : await files([value])]);
    }
  return sha256.hex(JSON.stringify(shape));
}

/** Whether an entry's files still exist and hash to its content hash. */
export async function verifyOutputs(
  entry: CacheEntry,
  hashFile: HashFileFn,
  keyDir: string,
): Promise<boolean> {
  try {
    return (await hashOutputFiles(entry.outputs, hashFile, keyDir)) === entry.contentHash;
  } catch {
    return false;
  }
}
