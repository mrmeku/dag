import type { DepRecord, Graph, NodeRef } from "@mrmeku/dagraph";
import { errorMessage } from "./kernel/format.ts";
import type { Ports } from "./ports.ts";
import { post } from "./post.ts";
import type { PostRef, WaitRoles } from "./steps.ts";
import { addTask } from "./task.ts";

/**
 * What `workflow.cache` takes: the inputs of `actions/cache`, `path`, `key` and `restore-keys`,
 * and the `name` of its tasks, `restore:<name>` and `save:<name>`, `cache` unless given.
 */
export interface ActionsCacheSpec {
  name?: string;
  path: string[];
  key: string;
  restoreKeys?: string[];
}

/** What `workflow.cache` returns: `actions/cache` as tasks, its restore and the adder of its save. */
export interface ActionsCacheTasks {
  /**
   * The restore, `restore:<name>`, which runs every time. It tries `key`, then each prefix in
   * `restoreKeys`, and logs what it found. It has no outputs, so a hit and a miss key its
   * dependents alike: `deps: { cas: cas.restore }` orders a task after it, and no task can tell
   * a hit from a miss.
   */
  restore: NodeRef<Record<never, string>>;
  /**
   * Adds the save, `save:<name>`, a post of the restore: it waits for every node of the run
   * downstream of the restore, whatever they did, and is owed after a cancel. Its `deps` are
   * ordinary deps, required unless `settled`: `cas.save({ deps: { install } })` saves only after
   * an install succeeded. It is never cached: it asks the service whether it holds `key` and
   * saves only when it does not, so a second run saves nothing and an evicted entry is saved
   * again. A save the service refuses is a warning; an invalid key fails it. Its `cacheId`,
   * `save.json`, holds what `@actions/cache` returned, the entry's id or -1 when the toolkit did
   * not save, or null when the service held `key` or refused the save. What it returns only a post's `main` takes.
   */
  save: (saveSpec?: {
    deps?: DepRecord & { main?: never } & WaitRoles;
  }) => PostRef<Record<"cacheId", string>>;
}

/** `actions/cache` as a task and a post over the `actionsCache` port: see `ActionsCacheTasks`. */
export function cache(graph: Graph<Ports>, spec: ActionsCacheSpec): ActionsCacheTasks {
  const name = spec.name ?? "cache";
  const { path, key } = spec;
  const restoreKeys = spec.restoreKeys ?? [];
  const restore = addTask(graph, {
    name: `restore:${name}`,
    cacheable: false,
    action: async ({ ports, log }) => {
      const matched = await ports.actionsCache.restoreCache(path, key, restoreKeys);
      log(
        matched
          ? `Cache restored from key: ${matched}`
          : `Cache not found for input keys: ${[key, ...restoreKeys].join(", ")}`,
      );
    },
  });
  return {
    restore,
    save: (saveSpec = {}) =>
      post(graph, {
        name: `save:${name}`,
        main: restore,
        ...(saveSpec.deps && { deps: saveSpec.deps }),
        outputs: { cacheId: "save.json" },
        action: async ({ ports, out, log, warn }) => {
          const done = (cacheId: number | null) =>
            ports.fs.writeText(out.cacheId, JSON.stringify(cacheId));
          let held: string | undefined;
          try {
            held = await ports.actionsCache.restoreCache(path, key, [], { lookupOnly: true });
          } catch (e) {
            log(`Cache lookup failed, saving anyway: ${errorMessage(e)}`);
          }
          // The service also matches `key` as a prefix, so only `key` itself means it holds it,
          // compared as actions/cache's isExactKeyMatch does: case aside, as the service matches.
          if (held?.localeCompare(key, undefined, { sensitivity: "accent" }) === 0) {
            log(`Cache hit occurred on the primary key ${key}, not saving cache.`);
            return done(null);
          }
          let cacheId: number;
          try {
            cacheId = await ports.actionsCache.saveCache(path, key);
          } catch (e) {
            if (e instanceof Error && e.name === "ValidationError") throw e;
            warn(`Failed to save: ${errorMessage(e)}`);
            return done(null);
          }
          // The toolkit returns -1 when it did not save: the key exists already, or there is no service.
          log(cacheId < 0 ? `Cache not saved with key: ${key}` : `Cache saved with key: ${key}`);
          return done(cacheId);
        },
      }),
  };
}
