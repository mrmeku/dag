import {
  errorMessage,
  settled,
  type DepRecord,
  type FileSystem,
  type Graph,
  type NodeRef,
} from "@mrmeku/dagraph";
import { PARTIAL_KEY_MARKER } from "../config/index.ts";
import { addTask, waitRole, type TaskPorts } from "../tasks/index.ts";

/**
 * Where `workflow.cache` keeps its paths between runs. `restore` puts `paths` back from the saved
 * cache under `cacheKey`, or the newest whose cache key starts with `cacheKey` or a `restoreKeys`
 * prefix, and resolves to what it restored from, or undefined on a miss. `save` keeps `paths` under
 * `cacheKey` unless the store holds it already, and resolves to whether it saved. A
 * `ValidationError` rejection, for an invalid cache key or path, fails the task; any other is a
 * warning.
 */
export interface CacheStore {
  restore: (
    paths: string[],
    cacheKey: string,
    restoreKeys: string[],
  ) => Promise<string | undefined>;
  save: (paths: string[], cacheKey: string) => Promise<boolean>;
}

/** No cache store: every restore misses and every save is a no-op. */
export const nullCacheStore: CacheStore = {
  restore: async () => undefined,
  save: async () => false,
};

/** The ports a cache's nodes read. */
export type CachePorts = TaskPorts & { cacheStore: CacheStore };

/** A cache's save as `addCache` records it: its restore, and how a run adds it with its waits. */
interface SaveRecord<P extends CachePorts = CachePorts> {
  restore: string;
  addTo: (graph: Graph<P>, waits: DepRecord) => void;
}

/** The saves of each graph `addCache` added nodes to, by node name. */
const saveRecords = new WeakMap<object, Map<string, unknown>>();

/** The saves recorded beside `graph`, by node name, in the order they were added. */
export const savesOf = <P extends CachePorts>(
  graph: Graph<P>,
): ReadonlyMap<string, SaveRecord<P>> =>
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- only recordSave writes a graph's records, each typed by that graph's ports
  (saveRecords.get(graph) ?? new Map()) as ReadonlyMap<string, SaveRecord<P>>;

/** Record `name` as a save of `graph`. */
export function recordSave<P extends CachePorts>(
  graph: Graph<P>,
  name: string,
  save: SaveRecord<P>,
): void {
  saveRecords.set(graph, (saveRecords.get(graph) ?? new Map<string, unknown>()).set(name, save));
}

/**
 * What `workflow.cache` takes: the inputs of `actions/cache`, `path`, `key` (its cache key) and
 * `restore-keys`, and the `name` of its tasks, `restore:<name>` and `save:<name>`, `cache` unless
 * given.
 */
export interface ActionsCacheSpec {
  name?: string;
  /** The run's cache dir and durations dir unless given. */
  path?: string[];
  key: string;
  restoreKeys?: string[];
}

/** What a cache's `save` takes. */
export interface SaveSpec {
  /**
   * What a run where a task did not succeed saves. `save`, the default: what succeeded, under
   * `<key>-partial-<run id>`, which the next run's restore finds as a prefix of `key`, so a flaky
   * test still leaves a cache. `skip`: nothing, as `actions/cache`'s `post-if: success()`. Only a
   * run where every task succeeded saves under `key`, so a partial save never takes that cache
   * key. The save waits for no post step, so a failed post step does not count.
   */
  partial?: "save" | "skip";
}

/** What `workflow.cache` returns: `actions/cache` as tasks, its restore and the adder of its save. */
export interface ActionsCacheTasks {
  /**
   * The restore, `restore:<name>`, which runs every time. It tries `key`, then each prefix in
   * `restoreKeys`, and logs what it found, with which paths of `path` it restored and which were
   * there already. A restore that fails warns and misses, as the toolkit's does; an invalid cache
   * key fails it. It has no outputs, so a hit and a miss key its dependents alike: `deps: { cache:
   * cache.restore }` orders a task after it, and no task can tell a hit from a miss.
   */
  restore: NodeRef<Record<never, string>>;
  /**
   * Adds the save, `save:<name>`. It waits for every other node of the run, whatever they did,
   * releases and other saves aside, so a node added later is never left out. It is an ordinary
   * node: a cancel stops it, and nothing owes it. It is never cached: the store saves only a cache
   * key it does not hold, so a second run saves nothing and an evicted cache is saved again. A save
   * the store refuses is a warning; an invalid cache key fails it. Nothing depends on it, so it
   * returns nothing.
   */
  save: (saveSpec?: SaveSpec) => void;
}

/**
 * Whether `path` holds anything now, by the local store's rule as far as the `fs` port shows it:
 * a file, or a directory with one anywhere in it. The port follows links, so a link counts by
 * what it leads to, and one that leads nowhere does not, where the store counts every link.
 * Listing a file fails, and a missing path or an empty directory lists nothing.
 */
async function holdsAnything(fs: FileSystem, path: string): Promise<boolean> {
  const names = await fs.readdir(path).catch(() => undefined);
  if (names === undefined) return true;
  for (const name of names) if (await holdsAnything(fs, `${path}/${name}`)) return true;
  return false;
}

/** The entries of a cache's `path` that hold anything now; a pattern never does. */
async function presentPaths(fs: FileSystem, path: string[]): Promise<string[]> {
  const present = await Promise.all(path.map((entry) => holdsAnything(fs, entry)));
  return path.filter((_entry, index) => present[index]);
}

/**
 * `actions/cache` as two tasks over the `cacheStore` port: see `ActionsCacheTasks`. `path` defaults
 * to the cache dir and the durations dir, and `runId` names a partial save.
 */
export function addCache<P extends CachePorts>(
  graph: Graph<P>,
  spec: ActionsCacheSpec,
  run: { cacheDir: string; durationsDir: string; runId: number },
): ActionsCacheTasks {
  const name = spec.name ?? "cache";
  const { key, path = [run.cacheDir, run.durationsDir] } = spec;
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
    const addTo = (target: Graph<P>, waits: DepRecord) =>
      void addTask(target, {
        name: `save:${name}`,
        deps: waits,
        cacheable: false,
        outputs: { saved: "save.json" },
        action: async ({ ports, depOutputs, out, log, warn }) => {
          const writeSaved = (saved: boolean) =>
            ports.fs.writeText(out.saved, JSON.stringify(saved));
          const unsuccessful = Object.keys(waits).filter((role) => depOutputs[role] === undefined);
          if (unsuccessful.length > 0 && partial === "skip") {
            log(`Not saving cache: ${unsuccessful.length} of the run's nodes did not succeed.`);
            return writeSaved(false);
          }
          const savedKey =
            unsuccessful.length > 0 ? `${key}${PARTIAL_KEY_MARKER}${run.runId}` : key;
          let saved: boolean;
          try {
            saved = await ports.cacheStore.save(path, savedKey);
          } catch (e) {
            if (e instanceof Error && e.name === "ValidationError") throw e;
            warn(`Failed to save: ${errorMessage(e)}`);
            return writeSaved(false);
          }
          log(
            saved ? `Cache saved with key: ${savedKey}` : `Cache not saved with key: ${savedKey}`,
          );
          return writeSaved(saved);
        },
      });
    addTo(graph, { [waitRole(restore.name)]: settled(restore) });
    recordSave(graph, `save:${name}`, { restore: restore.name, addTo });
  };
  return { restore, save };
}
