import type * as actionsCache from "@actions/cache";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createActionsCacheStore } from "./index.ts";

/** How the toolkit refuses a cache key holding a comma, before it reaches the service. */
const INVALID_CACHE_KEY = Object.assign(
  new Error("Key Validation Error: in,valid cannot contain commas."),
  { name: "ValidationError" },
);

/**
 * `@actions/cache` as it reaches the service: a restore or lookup matches the cache key, then
 * each restore key, as a prefix, newest saved cache first; a save adds a saved cache and returns
 * its id. A lookup of `unreachable` fails, a save of `refused` gets -1, as the toolkit returns
 * when it did not save, and `in,valid` is refused by both as the toolkit refuses it.
 */
function cacheModule(cacheKeys: string[]) {
  const savedCaches = [...cacheKeys];
  const restoreCache: typeof actionsCache.restoreCache = async (
    _paths,
    primaryKey,
    restoreKeys = [],
  ) => {
    if (primaryKey === "in,valid") throw INVALID_CACHE_KEY;
    if (primaryKey === "unreachable") throw new Error("connect ECONNREFUSED");
    return [primaryKey, ...restoreKeys]
      .map((prefix) =>
        savedCaches.findLast((k) => k.toLowerCase().startsWith(prefix.toLowerCase())),
      )
      .find((k) => k !== undefined);
  };
  const saveCache: typeof actionsCache.saveCache = async (_paths, key) => {
    if (key === "in,valid") throw INVALID_CACHE_KEY;
    return key === "refused" ? -1 : savedCaches.push(key) - 1;
  };
  return { savedCaches, restoreCache, saveCache };
}

describe("the GitHub cache store", () => {
  test("saves a cache key the service lacks though a longer one matches it, saves nothing while the service holds it, case aside, and again once it is evicted; a failed lookup still saves, a cache id of 0 is saved and -1 is not, and the toolkit's ValidationError rejects the save", async () => {
    const cache = cacheModule(["cache-dir-10"]);
    const store = createActionsCacheStore(cache);
    const first = await store.save([".dag/cache"], "cache-dir-1");
    const again = await store.save([".dag/cache"], "cache-dir-1");
    const otherCase = await store.save([".dag/cache"], "CACHE-DIR-1");
    cache.savedCaches.pop();
    const evicted = await store.save([".dag/cache"], "cache-dir-1");
    const unreachable = await store.save([".dag/cache"], "unreachable");
    const refused = await store.save([".dag/cache"], "refused");
    const firstOfAll = await createActionsCacheStore(cacheModule([])).save(
      [".dag/cache"],
      "cache-dir-1",
    );
    const invalid = await store.save([".dag/cache"], "in,valid").catch(String);
    assert.deepEqual(
      {
        saved: { first, again, otherCase, evicted, unreachable, refused, firstOfAll, invalid },
        savedCaches: cache.savedCaches,
        restored: await store.restore([".dag/cache"], "cache-dir-2", ["cache-dir-"]),
      },
      {
        saved: {
          first: true,
          again: false,
          otherCase: false,
          evicted: true,
          unreachable: true,
          refused: false,
          firstOfAll: true,
          invalid: "ValidationError: Key Validation Error: in,valid cannot contain commas.",
        },
        savedCaches: ["cache-dir-10", "cache-dir-1", "unreachable"],
        restored: "cache-dir-1",
      },
    );
  });
});
