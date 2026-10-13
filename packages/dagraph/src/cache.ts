import type { Outputs } from "./graph/index.ts";

/** What gets stored per action key in the cache. */
export interface CacheEntry {
  /** The file paths the action produced. */
  outputs: Outputs;
  /** SHA256 of actual file contents at those paths. */
  contentHash: string;
}

/** Minimal filesystem contract the DAG executor needs. Implementations ship in `ports/fs`. */
export interface DagFs {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  hashFile(path: string): Promise<string>;
  ensureDir(path: string): Promise<void>;
}

/** Content-addressed cache used by the executor to skip unchanged nodes. */
export interface Cache {
  get(key: string): Promise<CacheEntry | undefined>;
  put(key: string, entry: CacheEntry): Promise<void>;
}

/** Filesystem-backed cache. Stores manifests as JSON at {baseDir}/{actionKey}/manifest.json. */
export class FsCache implements Cache {
  private baseDir: string;
  private fs: DagFs;
  constructor(baseDir: string, fs: DagFs) {
    this.baseDir = baseDir;
    this.fs = fs;
  }
  async get(key: string): Promise<CacheEntry | undefined> {
    try {
      const raw = await this.fs.readText(`${this.baseDir}/${key}/manifest.json`);
      return JSON.parse(raw) as CacheEntry;
    } catch {
      return undefined;
    }
  }
  async put(key: string, entry: CacheEntry): Promise<void> {
    await this.fs.writeText(`${this.baseDir}/${key}/manifest.json`, JSON.stringify(entry, null, 2));
  }
}

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

/**
 * Two-level cache (local + remote). Reads check local first, then remote (populating local on
 * remote hit). Writes go to both.
 */
export class TieredCache implements Cache {
  public local: Cache;
  public remote: Cache;
  constructor(opts: { local: Cache; remote: Cache }) {
    this.local = opts.local;
    this.remote = opts.remote;
  }
  async get(key: string): Promise<CacheEntry | undefined> {
    const local = await this.local.get(key);
    if (local) return local;
    const remote = await this.remote.get(key);
    if (remote) {
      await this.local.put(key, remote);
      return remote;
    }
    return undefined;
  }
  async put(key: string, entry: CacheEntry): Promise<void> {
    await this.local.put(key, entry);
    await this.remote.put(key, entry);
  }
}
