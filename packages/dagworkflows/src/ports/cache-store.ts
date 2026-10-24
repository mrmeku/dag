import type * as actionsCache from "@actions/cache";
import type { CacheStore } from "../ports.ts";

/**
 * The GitHub cache store: `@actions/cache` as a CacheStore. A save asks the service first, and
 * saves only a key it does not hold, compared as actions/cache's isExactKeyMatch does, case aside:
 * the service also matches a key as a prefix. A save whose lookup fails saves anyway.
 */
export function createActionsCacheStore(
  cache: Pick<typeof actionsCache, "restoreCache" | "saveCache">,
): CacheStore {
  return {
    restore: (paths, key, restoreKeys) => cache.restoreCache(paths, key, restoreKeys),
    save: async (paths, key) => {
      const held = await cache
        .restoreCache(paths, key, [], { lookupOnly: true })
        .catch(() => undefined);
      if (held?.localeCompare(key, undefined, { sensitivity: "accent" }) === 0) return false;
      // The toolkit returns -1 when it did not save.
      return (await cache.saveCache(paths, key)) >= 0;
    },
  };
}

/**
 * No cache store: every restore misses and every save is a no-op. A GitHub run that cannot reach
 * the cache service gets it.
 */
export const nullCacheStore: CacheStore = {
  restore: async () => undefined,
  save: async () => false,
};

export interface MemoryCacheStore extends CacheStore {
  /** Saved keys in order, each with the paths it holds. */
  entries: Map<string, string[]>;
}

/**
 * An in-memory cache store for tests, with the service's matching rules: the primary key exactly,
 * else the primary key and then each restore key as a prefix, newest entry first. Saving an
 * existing key is a no-op, as on GitHub; deleting from `entries` is an eviction. It records keys
 * and paths and moves no files.
 */
export function createMemoryCacheStore(initialKeys: string[] = []): MemoryCacheStore {
  const entries = new Map<string, string[]>(initialKeys.map((k) => [k, []]));
  return {
    entries,
    restore: async (_paths, primaryKey, restoreKeys) => {
      if (entries.has(primaryKey)) return primaryKey;
      const newestFirst = [...entries.keys()].reverse();
      for (const prefix of [primaryKey, ...restoreKeys]) {
        const hit = newestFirst.find((k) => k.startsWith(prefix));
        if (hit) return hit;
      }
      return undefined;
    },
    save: async (paths, key) => {
      if (entries.has(key)) return false;
      entries.set(key, paths);
      return true;
    },
  };
}
