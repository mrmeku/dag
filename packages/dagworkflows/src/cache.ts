import { settled, type DepRecord, type Graph, type NodeRef } from "@mrmeku/dagraph";
import { PARTIAL_KEY_MARKER } from "./config.ts";
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
   * `restoreKeys`, and logs what it found, with which paths of `path` it restored and which were
   * there already. A restore that fails warns and misses, as the toolkit's does; an invalid key
   * fails it. It has no outputs, so a hit and a miss key its dependents alike: `deps: { cas:
   * cas.restore }` orders a task after it, and no task can tell a hit from a miss.
   */
  restore: NodeRef<Record<never, string>>;
  /**
   * Adds the save, `save:<name>`. It waits for every other node of the run, whatever they did,
   * releases and other saves aside, so a node added later is never left out. It is an ordinary
   * node: a cancel stops it, and nothing owes it. It is never cached: the store saves only a key
   * it does not hold, so a second run saves nothing and an evicted entry is saved again. A save
   * the store refuses is a warning; an invalid key fails it. Nothing depends on it, so it returns
   * nothing.
   */
  save: (saveSpec?: SaveSpec) => void;
}

/**
 * Whether `path` holds anything now, by the local store's rule as far as the `fs` port shows it:
 * a file, or a directory with one anywhere in it. The port follows links, so a link counts by
 * what it leads to, and one that leads nowhere does not, where the store counts every link.
 * Listing a file fails on disk and shows nothing in memory, where only a file can be hashed.
 */
async function holdsAnything(fs: Ports["fs"], path: string): Promise<boolean> {
  const names = await fs.readdir(path).catch(() => undefined);
  if (names === undefined) return true;
  for (const name of names) if (await holdsAnything(fs, `${path}/${name}`)) return true;
  if (names.length > 0 || !(await fs.exists(path))) return false;
  return fs.hashFile(path).then(
    () => true,
    () => false,
  );
}

/** The entries of a cache's `path` that hold anything now; a pattern never does. */
async function presentPaths(fs: Ports["fs"], path: string[]): Promise<string[]> {
  const present = await Promise.all(path.map((entry) => holdsAnything(fs, entry)));
  return path.filter((_entry, index) => present[index]);
}

/** `actions/cache` as two tasks over the `cacheStore` port: see `ActionsCacheTasks`. */
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
    action: async ({ ports, log, warn }) => {
      const before = await presentPaths(ports.fs, path);
      let source: string | undefined;
      try {
        source = await ports.cacheStore.restore(path, key, restoreKeys);
      } catch (e) {
        // A miss, as the toolkit makes of every failure but an invalid key: caching is optional.
        if (e instanceof Error && e.name === "ValidationError") throw e;
        warn(`Failed to restore: ${errorMessage(e)}`);
      }
      if (source === undefined)
        log(`Cache not found for input keys: ${[key, ...restoreKeys].join(", ")}`);
      else {
        log(`Cache restored from: ${source}`);
        const restored = (await presentPaths(ports.fs, path)).filter(
          (entry) => !before.includes(entry),
        );
        if (restored.length > 0) log(`Restored: ${restored.join(", ")}`);
      }
      if (before.length > 0) log(`Kept, already there: ${before.join(", ")}`);
    },
  });
  const save = ({ partial = "save" }: SaveSpec = {}) => {
    const addTo = (target: Graph<Ports>, waits: DepRecord) =>
      void addTask(target, {
        name: `save:${name}`,
        deps: waits,
        cacheable: false,
        outputs: { saved: "save.json" },
        action: async ({ ports, depOutputs, out, log, warn }) => {
          const done = (saved: boolean) => ports.fs.writeText(out.saved, JSON.stringify(saved));
          const failed = Object.keys(waits).filter((role) => depOutputs[role] === undefined);
          if (failed.length > 0 && partial === "skip") {
            log(`Not saving cache: ${failed.length} of the run's nodes did not succeed.`);
            return done(false);
          }
          const savedKey = failed.length > 0 ? `${key}${PARTIAL_KEY_MARKER}${ctx.runId}` : key;
          let saved: boolean;
          try {
            saved = await ports.cacheStore.save(path, savedKey);
          } catch (e) {
            if (e instanceof Error && e.name === "ValidationError") throw e;
            warn(`Failed to save: ${errorMessage(e)}`);
            return done(false);
          }
          log(
            saved ? `Cache saved with key: ${savedKey}` : `Cache not saved with key: ${savedKey}`,
          );
          return done(saved);
        },
      });
    addTo(graph, { [waitRole(restore.name)]: settled(restore) });
    recordSave(graph, `save:${name}`, { restore: restore.name, addTo });
  };
  return { restore, save };
}
