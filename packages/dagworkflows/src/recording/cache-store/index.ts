import type { CacheStore } from "../../actions-cache/index.ts";

export interface MemoryCacheStore extends CacheStore {
  /** The saved caches in the order received, each cache key with the paths it holds. */
  savedCaches: Map<string, string[]>;
}

/**
 * An in-memory cache store for tests, with the service's matching rules: the cache key exactly,
 * else the cache key and then each restore key as a prefix, newest saved cache first. Saving under
 * a held cache key is a no-op, as on GitHub; deleting from `savedCaches` is an eviction. It records
 * cache keys and paths and moves no files.
 */
export function createMemoryCacheStore(initialKeys: string[] = []): MemoryCacheStore {
  const savedCaches = new Map<string, string[]>(initialKeys.map((k) => [k, []]));
  return {
    savedCaches,
    restore: async (_paths, cacheKey, restoreKeys) => {
      if (savedCaches.has(cacheKey)) return cacheKey;
      const newestFirst = [...savedCaches.keys()].reverse();
      for (const prefix of [cacheKey, ...restoreKeys]) {
        const hit = newestFirst.find((k) => k.startsWith(prefix));
        if (hit) return hit;
      }
      return undefined;
    },
    save: async (paths, cacheKey) => {
      if (savedCaches.has(cacheKey)) return false;
      savedCaches.set(cacheKey, paths);
      return true;
    },
  };
}
