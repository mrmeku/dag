import { dirname, join, normalize } from "pathe";
import { collectPaths, isOutputs, mapPaths, type Outputs } from "../graph/index.ts";
import { hashOutputFiles, verifyOutputs } from "./content-addressing.ts";
import { isMissingFileError, type FileSystem, type Stats } from "./ports.ts";

/** A node's entry in the cache: what a result that succeeded carries, its paths absolute. */
export interface CacheEntry {
  /** The file paths the action produced. */
  outputs: Outputs;
  /** SHA256 of actual file contents at those paths. */
  contentHash: string;
  /** Each output's own hash, by name: what a dependent that reads that output keys on. */
  outputHashes: Record<string, string>;
}

export const isCacheEntry = (value: unknown): value is CacheEntry =>
  typeof value === "object" &&
  value !== null &&
  "outputs" in value &&
  isOutputs(value.outputs) &&
  "contentHash" in value &&
  typeof value.contentHash === "string" &&
  "outputHashes" in value &&
  typeof value.outputHashes === "object" &&
  value.outputHashes !== null &&
  Object.values(value.outputHashes).every((hash) => typeof hash === "string");

/** What a manifest records of each file, and a hit compares. */
type FileStats = Pick<Stats, "size" | "mtimeMs">;

type FileStatsByPath = Record<string, FileStats>;

/**
 * A key's entry as its manifest holds it: its paths relative to its content directory, and each
 * file's stats by that path.
 */
export type Manifest = CacheEntry & { fileStats: FileStatsByPath };

const isFileStats = (value: unknown): value is FileStats =>
  typeof value === "object" &&
  value !== null &&
  "size" in value &&
  typeof value.size === "number" &&
  "mtimeMs" in value &&
  typeof value.mtimeMs === "number";

const isManifest = (value: unknown): value is Manifest =>
  isCacheEntry(value) &&
  "fileStats" in value &&
  typeof value.fileStats === "object" &&
  value.fileStats !== null &&
  Object.values(value.fileStats).every(isFileStats);

/** Bump on any change to the on-disk format: a new format, a new directory. */
const CACHE_FORMAT_VERSION = "v1";

const MANIFEST_FILE = "manifest.json";

/**
 * The cache's directories: `formatDir` holds `<key>/manifest.json` and `<key>/<content hash>/`;
 * `tmpDir` holds what is staged before a rename into place or moved aside before removal.
 */
function cacheLayout(cacheDir: string): { formatDir: string; tmpDir: string } {
  return { formatDir: join(cacheDir, CACHE_FORMAT_VERSION), tmpDir: join(cacheDir, "tmp") };
}

/** How many renames a commit tries: attempts racing over a damaged copy each move it away. */
const PLACE_TRIES = 5;

/** Removes a directory, best effort: whether it is gone never changes a result. */
export const discard = (fs: FileSystem, dir: string) => fs.remove(dir).catch(() => {});

/** Sets `path`'s mtime to `now`, the last use a prune reads; best effort. */
async function stampLastUse(fs: FileSystem, now: number, path: string): Promise<void> {
  const time = new Date(now);
  await fs.utimes(path, time, time).catch(() => {});
}

/** The absolute path of a new staging directory in the cache at `cacheDir`, not yet made. */
export function newStagingDir(fs: FileSystem, cacheDir: string): string {
  return join(cacheLayout(fs.resolve(cacheDir)).tmpDir, crypto.randomUUID());
}

/** Whether each of `paths` in `dir` has the size and mtime that `fileStats` records for it. */
async function statsMatch(
  fs: FileSystem,
  dir: string,
  paths: string[],
  fileStats: FileStatsByPath,
): Promise<boolean> {
  for (const path of paths) {
    const recorded = fileStats[path];
    const found = await fs.lstat(join(dir, path)).catch(() => undefined);
    // Within a millisecond: `fs.cp` with `preserveTimestamps` truncates an mtime to one under Bun
    // and rounds it to one under Node.
    if (
      !recorded ||
      !found ||
      found.size !== recorded.size ||
      Math.abs(found.mtimeMs - recorded.mtimeMs) >= 1
    )
      return false;
  }
  return true;
}

/** The manifest at `path`, or `undefined` when it is missing, unreadable or no manifest. */
async function readManifest(fs: FileSystem, path: string): Promise<Manifest | undefined> {
  try {
    const manifest: unknown = JSON.parse(await fs.readText(path));
    return isManifest(manifest) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The entry of `key` in the cache at `cacheDir`, its paths absolute, when its manifest reads as an
 * entry whose files match the stats it records, or else hash to it; anything else is a miss. A hit
 * stamps the manifest's last use as `now`, in milliseconds since the epoch.
 */
export async function lookupEntry(
  fs: FileSystem,
  cacheDir: string,
  key: string,
  now: number,
): Promise<CacheEntry | undefined> {
  const keyDir = join(cacheLayout(fs.resolve(cacheDir)).formatDir, key);
  const manifestFile = join(keyDir, MANIFEST_FILE);
  const manifest = await readManifest(fs, manifestFile);
  if (!manifest) return undefined;
  const { fileStats, ...entry } = manifest;
  const contentDir = join(keyDir, entry.contentHash);
  const unchanged = await statsMatch(fs, contentDir, collectPaths(entry.outputs), fileStats);
  if (!unchanged && !(await verifyOutputs(entry, fs.hashFile, contentDir))) return undefined;
  await stampLastUse(fs, now, manifestFile);
  return { ...entry, outputs: mapPaths(entry.outputs, (path) => join(contentDir, path)) };
}

/**
 * Puts `stagingDir` at `contentDir`, or keeps the copy there when its files are regular and hash
 * right, returning their stats. A damaged copy is moved into `tmpDir`, replaced, then removed.
 */
async function placeContent(
  fs: FileSystem,
  entry: CacheEntry,
  stagingDir: string,
  contentDir: string,
  tmpDir: string,
): Promise<FileStatsByPath | undefined> {
  await fs.ensureDir(dirname(contentDir));
  const damaged: string[] = [];
  try {
    for (let tries = 1; ; tries++) {
      try {
        await fs.rename(stagingDir, contentDir);
        return undefined;
      } catch (e) {
        const copyStats = await sealFiles(fs, entry.outputs, contentDir).catch(() => undefined);
        if (copyStats && (await verifyOutputs(entry, fs.hashFile, contentDir))) {
          await discard(fs, stagingDir);
          return copyStats;
        }
        if (tries === PLACE_TRIES) throw e;
        const aside = join(tmpDir, crypto.randomUUID());
        // A racing attempt may have moved it away first.
        await fs.rename(contentDir, aside).catch(() => {});
        damaged.push(aside);
      }
    }
  } finally {
    for (const dir of damaged) await discard(fs, dir);
  }
}

/**
 * Makes each file of `outputs`, relative to `outputDir`, read-only, as `chmod a-w` does, flushes
 * it to disk, so a crash cannot leave one whose stats match but whose data is lost, and returns
 * the stats a hit compares, by path.
 */
async function sealFiles(
  fs: FileSystem,
  outputs: Outputs,
  outputDir: string,
): Promise<FileStatsByPath> {
  const fileStats: FileStatsByPath = {};
  for (const [name, value] of Object.entries(outputs))
    for (const path of [value].flat()) {
      const file = join(outputDir, path);
      const stats = await fs.lstat(file).catch((e: unknown) => {
        if (!isMissingFileError(e)) throw e;
        throw new Error(
          `output "${name}" (${path}) was not written. ` +
            `Write it at \`\${outputDir}/${path}\` before the action returns.`,
        );
      });
      if (!stats.isFile())
        throw new Error(
          `output "${name}" (${path}) is not a regular file. ` +
            "Return files only, never a directory or a symbolic link.",
        );
      await fs.chmod(file, stats.mode & 0o7555);
      await fs.fsync(file);
      fileStats[path] = { size: stats.size, mtimeMs: stats.mtimeMs };
    }
  return fileStats;
}

/**
 * Commits `stagingDir` as the entry of `key` whose files are `outputs`, each a regular file inside
 * it, made read-only, stamps its content dir's last use as `now`, and returns the entry. The
 * manifest, with the stats of the files left in place, is written over the key's last one only
 * when `writeManifest`.
 */
export async function commitEntry(
  fs: FileSystem,
  cacheDir: string,
  key: string,
  stagingDir: string,
  outputs: Outputs,
  writeManifest: boolean,
  now: number,
): Promise<CacheEntry> {
  const { formatDir, tmpDir } = cacheLayout(fs.resolve(cacheDir));
  const under = `${stagingDir}/`;
  const relativeOutputs = mapPaths(outputs, (path) => {
    const resolved = normalize(fs.resolve(path));
    if (!resolved.startsWith(under))
      throw new Error(`output not under the output dir: ${path} is not under ${stagingDir}`);
    return resolved.slice(under.length);
  });
  // Stats before the hash, so a hit hashes again a file written between the two.
  const stagedFileStats = await sealFiles(fs, relativeOutputs, stagingDir);
  const hashes = await hashOutputFiles(relativeOutputs, fs.hashFile, stagingDir);
  const relativeEntry: CacheEntry = { outputs: relativeOutputs, ...hashes };
  const keyDir = join(formatDir, key);
  const contentDir = join(keyDir, relativeEntry.contentHash);
  const keptFileStats = await placeContent(fs, relativeEntry, stagingDir, contentDir, tmpDir);
  await stampLastUse(fs, now, contentDir);
  if (writeManifest) {
    // Renamed into place, so a reader sees the whole last manifest or the whole new one.
    const stagedManifestFile = join(tmpDir, `${crypto.randomUUID()}.json`);
    const fileStats = keptFileStats ?? stagedFileStats;
    await fs.writeText(
      stagedManifestFile,
      JSON.stringify({ ...relativeEntry, fileStats } satisfies Manifest, null, 2),
    );
    await fs.rename(stagedManifestFile, join(keyDir, MANIFEST_FILE));
  }
  return { ...relativeEntry, outputs: mapPaths(relativeOutputs, (path) => join(contentDir, path)) };
}

export interface PruneOptions {
  /** A time in milliseconds since the epoch: what no run used since goes. */
  unusedSince: number;
}

/**
 * Removes from the cache at `cacheDir` what no run used since `unusedSince`, moving each into tmp
 * first, and resolves to the removed paths, sorted. Not locked against a run.
 */
export async function pruneCache(
  fs: FileSystem,
  cacheDir: string,
  { unusedSince }: PruneOptions,
): Promise<string[]> {
  const { formatDir, tmpDir } = cacheLayout(fs.resolve(cacheDir));
  // What a run moved since it was listed is in use.
  const lastUseOf = (path: string) =>
    fs.lstat(path).then(
      (stats) => stats.mtimeMs,
      () => Infinity,
    );
  const removedPaths: string[] = [];
  // Moved aside first, so a lookup finds it whole or gone.
  const removeAside = async (path: string) => {
    removedPaths.push(path);
    const aside = join(tmpDir, crypto.randomUUID());
    await fs.ensureDir(tmpDir);
    await fs.rename(path, aside);
    await fs.remove(aside);
  };
  for (const name of await fs.readdir(tmpDir)) {
    const path = join(tmpDir, name);
    if ((await lastUseOf(path)) < unusedSince) await removeAside(path);
  }
  for (const key of await fs.readdir(formatDir)) {
    const keyDir = join(formatDir, key);
    // Skips a stray file beside the key dirs, such as a Finder `.DS_Store`.
    if ((await fs.lstat(keyDir)).isFile()) continue;
    const lastUses = await Promise.all(
      (await fs.readdir(keyDir)).map(async (name) => ({
        name,
        lastUse: await lastUseOf(join(keyDir, name)),
      })),
    );
    if (Math.max(...lastUses.map(({ lastUse }) => lastUse)) < unusedSince) {
      await removeAside(keyDir);
      continue;
    }
    const manifest = await readManifest(fs, join(keyDir, MANIFEST_FILE));
    for (const { name, lastUse } of lastUses)
      if (name !== MANIFEST_FILE && name !== manifest?.contentHash && lastUse < unusedSince)
        await removeAside(join(keyDir, name));
  }
  return removedPaths.sort();
}
