import type * as actionsCache from "@actions/cache";
import type { CacheStore } from "../../actions-cache/index.ts";

/**
 * The GitHub cache store: `@actions/cache` as a CacheStore. A save asks the service first, and
 * saves only a cache key it does not hold, compared as actions/cache's isExactKeyMatch does, case
 * aside: the service also matches a cache key as a prefix. A save whose lookup fails saves anyway.
 */
export function createActionsCacheStore(
  cache: Pick<typeof actionsCache, "restoreCache" | "saveCache">,
): CacheStore {
  return {
    restore: (paths, cacheKey, restoreKeys) => cache.restoreCache(paths, cacheKey, restoreKeys),
    save: async (paths, cacheKey) => {
      const held = await cache
        .restoreCache(paths, cacheKey, [], { lookupOnly: true })
        .catch(() => undefined);
      if (held?.localeCompare(cacheKey, undefined, { sensitivity: "accent" }) === 0) return false;
      // The toolkit returns -1 when it did not save.
      return (await cache.saveCache(paths, cacheKey)) >= 0;
    },
  };
}
