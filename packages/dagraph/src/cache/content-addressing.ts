import { sha256 } from "js-sha256";
import { join } from "pathe";
import type { HashFile, Outputs } from "../graph/index.ts";
import type { CacheEntry } from "./cache.ts";

/** What a cache entry keeps of its outputs' content: its own hash and each output's. */
export type EntryHashes = Pick<CacheEntry, "contentHash" | "outputHashes">;

/** SHA256 hex of in-memory content; the one hash every `FileSystem` adapter agrees with. */
export function hashBytes(data: string | Uint8Array): string {
  return sha256.hex(data);
}

/**
 * The hashes of a node's outputs, whose paths are relative to `outputDir`: each output's own,
 * which a dependent that reads it keys on, and the content hash of them all. Each covers its
 * outputs' names, each file's path and each file's content. So which file an output names is part
 * of it, wherever `outputDir` sits.
 */
export async function hashOutputFiles(
  outputs: Outputs,
  hashFile: HashFile,
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
  hashFile: HashFile,
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
