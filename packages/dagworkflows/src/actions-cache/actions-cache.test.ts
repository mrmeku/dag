import {
  createMemoryFileSystem,
  execute,
  Graph,
  namedOutput,
  type MemoryFileSystem,
  type NodeResult,
} from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { manualTimer, okExec, steppingClock } from "../memory/index.ts";
import { createMemoryCacheStore } from "../recording/index.ts";
import { addTask } from "../tasks/index.ts";
import { addCache, type CachePorts, type CacheStore } from "./index.ts";

const CACHE_DIR = "/cache";
const RUN = { cacheDir: CACHE_DIR, durationsDir: "/state/durations", runId: 7 };
const portsOf = (cacheStore: CacheStore, fs = createMemoryFileSystem()) => ({
  exec: okExec,
  clock: steppingClock(),
  fs,
  cacheStore,
});
/** Executes `graph` with dagraph's `execute`: each node's result and what it printed, by name. */
async function executeCache(
  graph: Graph<CachePorts>,
  ports: CachePorts & { fs: MemoryFileSystem },
) {
  const printed = new Map<string, string>();
  const results = await execute(
    graph,
    { ports, fs: ports.fs, clock: ports.clock, startTimer: manualTimer(), cacheDir: CACHE_DIR },
    {
      onEvent: (event) => {
        if (event.type === "output")
          printed.set(event.node, (printed.get(event.node) ?? "") + event.chunk);
      },
    },
  );
  /** How the node settled: its message when it failed, else its outputs or `save.json`, and its log. */
  const settledOf = async (name: string): Promise<unknown> => {
    const result = results.find((r) => r.name === name);
    if (result?.status !== "succeeded") return result?.status === "failed" && result.error.message;
    const { outputs } = result.details.entry;
    const saved: unknown = name.startsWith("save:")
      ? JSON.parse(await ports.fs.readText(namedOutput(outputs, "saved")))
      : undefined;
    return { ...(saved === undefined ? { outputs } : { saved }), log: printed.get(name) };
  };
  return { results, settledOf };
}
/** How a node settled, in the words the run's output uses: built or cached, or its status. */
const outcomeOf = (result: NodeResult | undefined) =>
  result?.status === "succeeded" ? (result.details.actionRan ? "built" : "cached") : result?.status;
const validationError = (message: string) =>
  Object.assign(new Error(message), { name: "ValidationError" });

describe("a cache", () => {
  test("restores with no outputs, so its dependent keys alike after an exact hit, a restore-key hit and a miss; it logs what it found, which of its paths it restored and which were there already, never a pattern", async () => {
    const fs = createMemoryFileSystem({ "node_modules/a/index.js": "a" });
    const held = createMemoryCacheStore();
    // A store that puts `.dag/cache` back on a hit, as the toolkit's does.
    const cacheStore: CacheStore = {
      ...held,
      restore: async (paths, cacheKey, restoreKeys) => {
        const source = await held.restore(paths, cacheKey, restoreKeys);
        if (source) await fs.writeText(".dag/cache/blob", source);
        return source;
      },
    };
    const graph = new Graph<CachePorts>();
    const cacheDir = addCache(
      graph,
      {
        name: "cache-dir",
        path: [".dag/cache", "node_modules", "~/.bun/install/cache", "**/*.tsbuildinfo"],
        key: "cache-dir-2",
        restoreKeys: ["cache-dir-"],
      },
      RUN,
    );
    addTask(graph, {
      name: "lint",
      cmd: ["lint"],
      inputs: { version: "lint-v1" },
      deps: { cacheDir: cacheDir.restore },
    });
    const runs = [];
    for (const keys of [["cache-dir-2"], ["cache-dir-1"], []]) {
      held.savedCaches.clear();
      for (const key of keys) held.savedCaches.set(key, []);
      await fs.remove(".dag/cache");
      const { results, settledOf } = await executeCache(graph, portsOf(cacheStore, fs));
      runs.push({
        restore: await settledOf("restore:cache-dir"),
        lint: outcomeOf(results.find((r) => r.name === "lint")),
      });
    }
    const kept = "Kept, already there: node_modules\n";
    assert.deepEqual(runs, [
      {
        restore: {
          outputs: {},
          log: `Cache restored from: cache-dir-2\nRestored: .dag/cache\n${kept}`,
        },
        lint: "built",
      },
      {
        restore: {
          outputs: {},
          log: `Cache restored from: cache-dir-1\nRestored: .dag/cache\n${kept}`,
        },
        lint: "cached",
      },
      {
        restore: {
          outputs: {},
          log: `Cache not found for input keys: cache-dir-2, cache-dir-\n${kept}`,
        },
        lint: "cached",
      },
    ]);
  });

  test("saves the run's cache dir and durations dir unless given paths, under its cache key once: a store holding it saves nothing", async () => {
    const cacheStore = createMemoryCacheStore();
    const graph = new Graph<CachePorts>();
    addCache(graph, { key: "deps-1" }, RUN).save();
    const saveRun = async () =>
      (await executeCache(graph, portsOf(cacheStore))).settledOf("save:cache");
    assert.deepEqual(
      { first: await saveRun(), again: await saveRun(), savedCaches: [...cacheStore.savedCaches] },
      {
        first: { saved: true, log: "Cache saved with key: deps-1\n" },
        again: { saved: false, log: "Cache not saved with key: deps-1\n" },
        savedCaches: [["deps-1", [CACHE_DIR, RUN.durationsDir]]],
      },
    );
  });

  test("fails on a ValidationError with the store's message; any other rejection is a warning, a restore then missing and a save writing false", async () => {
    const invalid = "Key Validation Error: in,valid cannot contain commas.";
    const noPaths = "Path Validation Error: At least one directory or file path is required";
    const cacheStore: CacheStore = {
      restore: async (_paths, cacheKey) => {
        if (cacheKey === "in,valid") throw validationError(invalid);
        if (cacheKey === "busy-1") throw new Error("EACCES: permission denied, copyfile");
        return undefined;
      },
      save: async (paths) => {
        if (paths.length === 0) throw validationError(noPaths);
        throw new Error("Cache service responded with 429");
      },
    };
    const graph = new Graph<CachePorts>();
    addCache(graph, { name: "invalid", path: ["x"], key: "in,valid" }, RUN);
    addCache(graph, { name: "no-paths", path: [], key: "deps-1" }, RUN).save();
    addCache(
      graph,
      { name: "busy", path: ["x"], key: "busy-1", restoreKeys: ["busy-"] },
      RUN,
    ).save();
    const { settledOf } = await executeCache(graph, portsOf(cacheStore));
    assert.deepEqual(
      {
        "restore:invalid": await settledOf("restore:invalid"),
        "save:no-paths": await settledOf("save:no-paths"),
        "restore:busy": await settledOf("restore:busy"),
        "save:busy": await settledOf("save:busy"),
      },
      {
        "restore:invalid": invalid,
        "save:no-paths": noPaths,
        "restore:busy": {
          outputs: {},
          log:
            "::warning title=restore%3Abusy::Failed to restore: EACCES: permission denied, copyfile\n" +
            "Cache not found for input keys: busy-1, busy-\n",
        },
        "save:busy": {
          saved: false,
          log: "::warning title=save%3Abusy::Failed to save: Cache service responded with 429\n",
        },
      },
    );
  });

  test("refuses a second cache of one name and a second save() as dagraph refuses a duplicate name", () => {
    const graph = new Graph<CachePorts>();
    const deps = addCache(graph, { name: "deps", key: "deps-1" }, RUN);
    deps.save();
    const refusal = (add: () => void) => {
      try {
        add();
        return "accepted";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    const duplicate = (name: string) =>
      `Duplicate node name "${name}". Names are unique in a graph: give the node a name of its ` +
      `own, or add it through graph.subgraph(prefix, meta).`;
    assert.deepEqual(
      {
        cache: refusal(() => addCache(graph, { name: "deps", key: "deps-2" }, RUN)),
        save: refusal(() => deps.save()),
      },
      { cache: duplicate("restore:deps"), save: duplicate("save:deps") },
    );
  });
});
