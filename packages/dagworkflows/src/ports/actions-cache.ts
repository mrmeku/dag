import type { ActionsCache } from "../ports.ts";

/** No cache service: every restore misses and every save is a no-op. The local default. */
export const nullActionsCache: ActionsCache = {
  restoreCache: async () => undefined,
  saveCache: async () => -1,
};

export interface MemoryActionsCache extends ActionsCache {
  /** Saved keys in order, each with the paths it holds. */
  entries: Map<string, string[]>;
}

/**
 * An in-memory cache service for tests, with the service's matching rules: the primary key
 * exactly, else the primary key and then each restore key as a prefix, newest entry first. A
 * `lookupOnly` lookup answers the same. Saving an existing key is a no-op, as on GitHub; deleting
 * from `entries` is an eviction. It records keys and paths and moves no files.
 */
export function createMemoryActionsCache(initialKeys: string[] = []): MemoryActionsCache {
  const entries = new Map<string, string[]>(initialKeys.map((k) => [k, []]));
  return {
    entries,
    restoreCache: async (_paths, primaryKey, restoreKeys = []) => {
      if (entries.has(primaryKey)) return primaryKey;
      const newestFirst = [...entries.keys()].reverse();
      for (const prefix of [primaryKey, ...restoreKeys]) {
        const hit = newestFirst.find((k) => k.startsWith(prefix));
        if (hit) return hit;
      }
      return undefined;
    },
    saveCache: async (paths, key) => {
      if (entries.has(key)) return -1;
      entries.set(key, paths);
      return entries.size;
    },
  };
}
