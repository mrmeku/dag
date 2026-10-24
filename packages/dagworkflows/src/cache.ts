import { settled, type DepRecord, type Graph, type NodeRef } from "@mrmeku/dagraph";
import { errorMessage } from "./kernel/format.ts";
import type { CiContext, Ports } from "./ports.ts";
import { recordSave, waitRole } from "./steps.ts";
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

/** What a cache's `save` takes. */
export interface SaveSpec {
  /**
   * What a run where a task did not succeed saves. `save`, the default: what succeeded, under
   * `<key>-partial-<run id>`, which the next run's restore finds as a prefix of `key`, so a flaky
   * test still leaves a cache. `skip`: nothing, as `actions/cache`'s `post-if: success()`. Only a
   * run where every task succeeded saves under `key`, so a partial save never takes the key. The
   * save waits for no post step, so a failed post step does not count.
   */
  partial?: "save" | "skip";
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
   * Adds the save, `save:<name>`. It waits for every other node of the run, whatever they did,
   * releases and other saves aside, so a node added later is never left out. It is an ordinary
   * node: a cancel stops it, and nothing owes it. It is never cached: it asks the service whether
   * it holds the key and saves only when it does not, so a second run saves nothing and an
   * evicted entry is saved again. A save the service refuses is a warning; an invalid key fails
   * it. Nothing depends on it, so it returns nothing.
   */
  save: (saveSpec?: SaveSpec) => void;
}

/** `actions/cache` as two tasks over the `actionsCache` port: see `ActionsCacheTasks`. */
export function cache(
  graph: Graph<Ports>,
  spec: ActionsCacheSpec,
  ctx: CiContext,
): ActionsCacheTasks {
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
  const save = ({ partial = "save" }: SaveSpec = {}) => {
    const addTo = (target: Graph<Ports>, waits: DepRecord) =>
      void addTask(target, {
        name: `save:${name}`,
        deps: waits,
        cacheable: false,
        outputs: { cacheId: "save.json" },
        action: async ({ ports, depOutputs, out, log, warn }) => {
          const done = (cacheId: number | null) =>
            ports.fs.writeText(out.cacheId, JSON.stringify(cacheId));
          const failed = Object.keys(waits).filter((role) => depOutputs[role] === undefined);
          if (failed.length > 0 && partial === "skip") {
            log(`Not saving cache: ${failed.length} of the run's nodes did not succeed.`);
            return done(null);
          }
          const saved = failed.length > 0 ? `${key}-partial-${ctx.runId}` : key;
          let held: string | undefined;
          try {
            held = await ports.actionsCache.restoreCache(path, saved, [], { lookupOnly: true });
          } catch (e) {
            log(`Cache lookup failed, saving anyway: ${errorMessage(e)}`);
          }
          // The service also matches the key as a prefix, so only the key itself means it holds
          // it, compared as actions/cache's isExactKeyMatch does: case aside, as the service matches.
          if (held?.localeCompare(saved, undefined, { sensitivity: "accent" }) === 0) {
            log(`Cache hit occurred on the primary key ${saved}, not saving cache.`);
            return done(null);
          }
          let cacheId: number;
          try {
            cacheId = await ports.actionsCache.saveCache(path, saved);
          } catch (e) {
            if (e instanceof Error && e.name === "ValidationError") throw e;
            warn(`Failed to save: ${errorMessage(e)}`);
            return done(null);
          }
          // The toolkit returns -1 when it did not save: the key exists already, or there is no service.
          log(
            cacheId < 0 ? `Cache not saved with key: ${saved}` : `Cache saved with key: ${saved}`,
          );
          return done(cacheId);
        },
      });
    addTo(graph, { [waitRole(restore.name)]: settled(restore) });
    recordSave(graph, `save:${name}`, { restore: restore.name, addTo });
  };
  return { restore, save };
}
