import { isOutputs, type Outputs } from "./graph/index.ts";

/** What gets stored per action key in the cache. */
export interface CacheEntry {
  /** The file paths the action produced. */
  outputs: Outputs;
  /** SHA256 of actual file contents at those paths. */
  contentHash: string;
}

export const isCacheEntry = (value: unknown): value is CacheEntry =>
  typeof value === "object" &&
  value !== null &&
  "outputs" in value &&
  isOutputs(value.outputs) &&
  "contentHash" in value &&
  typeof value.contentHash === "string";

/**
 * Minimal filesystem contract the DAG executor needs. Implementations ship in `ports/fs`. The
 * engine calls its members detached, as `fs.hashFile`, so none may read `this`.
 */
export interface DagFs {
  exists: (path: string) => Promise<boolean>;
  readText: (path: string) => Promise<string>;
  writeText: (path: string, content: string) => Promise<void>;
  /**
   * The SHA256 hex of a file's content. With no file at `path`, it rejects with an error whose
   * `code` is `"ENOENT"`, as `node:fs` does: so the engine names an output that was not written.
   */
  hashFile: (path: string) => Promise<string>;
  ensureDir: (path: string) => Promise<void>;
  /** POSIX `rename`: replaces a file at `to` atomically; fails when `to` is a non-empty directory. */
  rename: (from: string, to: string) => Promise<void>;
  /** Removes a file, or a directory and everything in it; nothing when the path does not exist. */
  remove: (path: string) => Promise<void>;
  /** The names of the entries in a directory; none when the directory does not exist. */
  readdir: (dir: string) => Promise<string[]>;
  /** The absolute form of `path`, as an action sees it. */
  resolve: (path: string) => string;
}

/** Content-addressed cache used by the executor to skip unchanged nodes. */
export interface Cache {
  get(key: string): Promise<CacheEntry | undefined>;
  put(key: string, entry: CacheEntry): Promise<void>;
}

/**
 * Filesystem-backed cache. Stores manifests as JSON at {baseDir}/{actionKey}/manifest.json, each
 * written beside it and renamed into place, so a reader never sees half of one.
 */
export class FsCache implements Cache {
  private baseDir: string;
  private fs: DagFs;
  constructor(baseDir: string, fs: DagFs) {
    this.baseDir = baseDir;
    this.fs = fs;
  }
  async get(key: string): Promise<CacheEntry | undefined> {
    try {
      const entry: unknown = JSON.parse(
        await this.fs.readText(`${this.baseDir}/${key}/manifest.json`),
      );
      return isCacheEntry(entry) ? entry : undefined;
    } catch {
      return undefined;
    }
  }
  async put(key: string, entry: CacheEntry): Promise<void> {
    const path = `${this.baseDir}/${key}/manifest.json`;
    const written = `${path}.${crypto.randomUUID()}`;
    await this.fs.writeText(written, JSON.stringify(entry, null, 2));
    await this.fs.rename(written, path);
  }
}

/**
 * `cache` with every read of `keys` a miss, or of every key without them: the nodes of those keys
 * run again and write their new entries, which later reads hit. This is how to force nodes.
 */
export const forcedCache = (cache: Cache, keys?: ReadonlySet<string>): Cache => ({
  get: async (key) => (keys && !keys.has(key) ? cache.get(key) : undefined),
  put: (key, entry) => cache.put(key, entry),
});

/** In-memory cache for testing. Entries are lost when the process exits. */
export class MemCache implements Cache {
  private entries = new Map<string, CacheEntry>();
  async get(key: string): Promise<CacheEntry | undefined> {
    return this.entries.get(key);
  }
  async put(key: string, entry: CacheEntry): Promise<void> {
    this.entries.set(key, entry);
  }
}
