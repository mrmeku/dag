import { sha256 } from "js-sha256";
import type { CacheEntry } from "./cache.ts";
import type { Outputs } from "./graph/index.ts";

/** Flatten an Outputs value (string, array, or record) into a flat list of file paths. */
export function collectPaths(outputs: Outputs): string[] {
  if (typeof outputs === "string") return [outputs];
  if (Array.isArray(outputs)) return outputs;
  return Object.values(outputs).flatMap((v) => (Array.isArray(v) ? v : [v]));
}

const MISSING_OPTIONAL_DEP = "missing";

export type HashFileFn = (path: string) => Promise<string>;

/** SHA256 hex of in-memory content; the one hash every DagFs implementation should agree with. */
export function hashBytes(data: string | Uint8Array): string {
  return sha256.hex(data);
}

/** Per-execution memo for input file hashes, so many nodes listing the same files hash them once. */
export type InputHashMemo = Map<string, Promise<string>>;

/**
 * Hash a node's declared input files. Returns a map path -> content hash, empty when the node
 * declares no inputs.
 */
export async function hashInputs(
  node: { inputs?: string[] },
  hashFile: HashFileFn,
  memo: InputHashMemo = new Map(),
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const path of node.inputs ?? []) {
    let pending = memo.get(path);
    if (!pending) {
      pending = hashFile(path);
      memo.set(path, pending);
    }
    result.set(path, await pending);
  }
  return result;
}

/**
 * Compute the action key for a node: SHA256(name + config + sorted dep content hashes + sorted
 * input file hashes). This is the cache key — identical inputs always produce the same key. A
 * failed optional dep hashes as missing, so the node re-runs once that dep succeeds. Nodes
 * without inputs hash exactly as before inputs existed.
 */
export function computeActionKey(
  node: {
    name: string;
    config: string;
    deps: string[];
    optionalDeps?: string[];
    inputs?: string[];
  },
  depHashes: Map<string, string>,
  inputHashes: Map<string, string> = new Map(),
): string {
  const h = sha256.create();
  h.update(node.name);
  h.update(node.config);
  const sorted = [...node.deps].sort();
  for (const dep of sorted) {
    h.update(dep);
    const depHash = depHashes.get(dep);
    if (depHash !== undefined) h.update(depHash);
    else if (node.optionalDeps?.includes(dep)) h.update(MISSING_OPTIONAL_DEP);
    else throw new Error(`BUG: missing content hash for dep "${dep}"`);
  }
  for (const path of [...(node.inputs ?? [])].sort()) {
    const hash = inputHashes.get(path);
    if (hash === undefined) throw new Error(`BUG: missing content hash for input "${path}"`);
    h.update(path);
    h.update(hash);
  }
  return h.hex();
}

/**
 * Compute a content hash over a node's output files. Used after execution to detect whether
 * outputs actually changed (early cutoff) and to store in the cache for downstream dep hashing.
 */
export async function hashOutputFiles(outputs: Outputs, hashFile: HashFileFn): Promise<string> {
  const paths = collectPaths(outputs).sort();
  const h = sha256.create();
  h.update(String(paths.length));
  for (const p of paths) h.update(await hashFile(p));
  return h.hex();
}

/**
 * Check that a cache entry's output files still exist and match their recorded content hash.
 * Returns false if any file is missing or corrupted. Called before accepting a cache hit.
 */
export async function verifyOutputs(entry: CacheEntry, hashFile: HashFileFn): Promise<boolean> {
  try {
    const currentHash = await hashOutputFiles(entry.outputs, hashFile);
    return currentHash === entry.contentHash;
  } catch {
    return false;
  }
}
