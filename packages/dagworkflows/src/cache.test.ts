import { execute, Graph, MemCache, namedOutput, type Result } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cache } from "./cache.ts";
import { addCommand } from "./commands.ts";
import type { Ports } from "./ports.ts";
import { createActionsCacheStore, createMemoryCacheStore } from "./ports/cache-store.ts";
import { createTestPorts } from "./ports/memory.ts";
import { logPath } from "./steps.ts";

const CAS = "/cas";

/** Executes `graph` under `ports`, on a cache of its own unless given one. */
const executeUnder = (graph: Graph<Ports>, ports: Ports, store = new MemCache()) =>
  execute(graph, { ports, cache: store, fs: ports.fs, casBaseDir: CAS });

/**
 * A cache service as `@actions/cache` reaches it: a restore matches the primary key, then each
 * restore key, as a prefix, newest entry first; a save adds an entry and returns its id.
 */
function serviceOf(keys: string[]) {
  const entries = [...keys];
  return {
    entries,
    restoreCache: async (_paths: string[], primaryKey: string, restoreKeys: string[] = []) =>
      [primaryKey, ...restoreKeys]
        .map((prefix) => entries.findLast((k) => k.startsWith(prefix)))
        .find((k) => k !== undefined),
    saveCache: async (_paths: string[], key: string) => entries.push(key),
  };
}

/** A save's `saved` and log once it ran, or the message it failed with. */
async function saveOutcome(fs: Ports["fs"], save: Result | undefined): Promise<unknown> {
  assert.ok(save, "a save");
  if (save.status === "failed") return save.error.message;
  assert.ok(save.status === "done", save.status);
  const saved: unknown = JSON.parse(await fs.readText(namedOutput(save.outputs, "saved")));
  return { saved, log: await fs.readText(logPath(CAS, save.actionKey)) };
}

describe("cache", () => {
  test("the restore logs what it found and has no outputs, so its dependent keys alike after an exact hit, a restore-key hit and a miss", async () => {
    const { ports: p, fs } = createTestPorts();
    const graph = new Graph<Ports>();
    const cas = cache(
      graph,
      { name: "cas", path: [".cas"], key: "cas-2", restoreKeys: ["cas-"] },
      await p.host.context(),
    );
    addCommand(graph, {
      name: "lint",
      cmd: ["lint"],
      inputs: { version: "lint-v1" },
      deps: { cas: cas.restore },
    });
    const store = new MemCache();
    const runs = [];
    for (const held of [["cas-2"], ["cas-1"], []]) {
      const cacheStore = createMemoryCacheStore(held);
      const results = await executeUnder(graph, { ...p, cacheStore }, store);
      const restore = results.find((r) => r.name === "restore:cas");
      assert.ok(restore?.status === "done", "restore:cas");
      runs.push({
        restore: {
          outputs: restore.outputs,
          log: await fs.readText(logPath(CAS, restore.actionKey)),
        },
        lint: results.find((r) => r.name === "lint")?.status,
      });
    }
    assert.deepEqual(runs, [
      { restore: { outputs: {}, log: "Cache restored from: cas-2\n" }, lint: "done" },
      { restore: { outputs: {}, log: "Cache restored from: cas-1\n" }, lint: "cached" },
      {
        restore: { outputs: {}, log: "Cache not found for input keys: cas-2, cas-\n" },
        lint: "cached",
      },
    ]);
  });

  test("on GitHub the save asks the service first: it saves a key the service lacks though a longer one matches it, saves nothing on a run again, and saves again once the entry is evicted", async () => {
    const service = serviceOf(["cas-10"]);
    const { ports: p, fs } = createTestPorts();
    p.cacheStore = createActionsCacheStore(service);
    const graph = new Graph<Ports>();
    cache(graph, { name: "cas", path: [".cas"], key: "cas-1" }, await p.host.context()).save();
    const store = new MemCache();
    const saveRun = async () =>
      saveOutcome(
        fs,
        (await executeUnder(graph, p, store)).find((r) => r.name === "save:cas"),
      );
    const first = await saveRun();
    const again = await saveRun();
    service.entries.pop();
    const evicted = await saveRun();
    assert.deepEqual(
      { first, again, evicted, entries: service.entries },
      {
        first: { saved: true, log: "Cache saved with key: cas-1\n" },
        again: { saved: false, log: "Cache not saved with key: cas-1\n" },
        evicted: { saved: true, log: "Cache saved with key: cas-1\n" },
        entries: ["cas-10", "cas-1"],
      },
    );
  });

  test("on GitHub a save whose lookup throws still saves; a refused save is a warning, not a failure; an invalid key fails it", async () => {
    const service = serviceOf([]);
    const { ports: p, fs } = createTestPorts();
    p.cacheStore = createActionsCacheStore({
      restoreCache: async (paths, key, restoreKeys) => {
        if (key === "unreachable") throw new Error("connect ECONNREFUSED");
        return service.restoreCache(paths, key, restoreKeys);
      },
      saveCache: async (paths, key) => {
        if (key === "refused") throw new Error("Cache service responded with 429");
        if (key === "in,valid")
          throw Object.assign(new Error("Key Validation Error: in,valid cannot contain commas."), {
            name: "ValidationError",
          });
        return service.saveCache(paths, key);
      },
    });
    const graph = new Graph<Ports>();
    const ctx = await p.host.context();
    for (const [name, key] of [
      ["unreachable", "unreachable"],
      ["refused", "refused"],
      ["invalid", "in,valid"],
    ] as const)
      cache(graph, { name, path: [name], key }, ctx).save();
    const saves = (await executeUnder(graph, p)).filter((r) => r.name.startsWith("save:"));
    const outcomes = await Promise.all(
      saves.map(async (r): Promise<[string, unknown]> => [r.name, await saveOutcome(fs, r)]),
    );
    assert.deepEqual(
      {
        saves: Object.fromEntries(outcomes),
        entries: service.entries,
      },
      {
        saves: {
          "save:unreachable": { saved: true, log: "Cache saved with key: unreachable\n" },
          "save:refused": {
            saved: false,
            log: "::warning title=save%3Arefused::Failed to save: Cache service responded with 429\n",
          },
          "save:invalid": "Key Validation Error: in,valid cannot contain commas.",
        },
        entries: ["unreachable"],
      },
    );
  });

  test("a restore that fails warns and misses, so what depends on it runs; an invalid key fails it", async () => {
    const service = createMemoryCacheStore();
    const { ports: p, fs } = createTestPorts({ cacheStore: service });
    service.restore = async (_paths, key) => {
      if (key === "in,valid")
        throw Object.assign(new Error("Key Validation Error: in,valid cannot contain commas."), {
          name: "ValidationError",
        });
      throw new Error("EACCES: permission denied, copyfile");
    };
    const graph = new Graph<Ports>();
    const ctx = await p.host.context();
    const cas = cache(
      graph,
      { name: "cas", path: [".cas"], key: "cas-1", restoreKeys: ["cas-"] },
      ctx,
    );
    cache(graph, { name: "invalid", path: ["x"], key: "in,valid" }, ctx);
    addCommand(graph, { name: "lint", cmd: ["lint"], deps: { cas: cas.restore } });
    const results = await executeUnder(graph, p);
    const outcomeOf = async (name: string) => {
      const result = results.find((r) => r.name === name);
      assert.ok(result, name);
      if (result.status === "failed") return result.error.message;
      return { status: result.status, log: await fs.readText(logPath(CAS, result.actionKey)) };
    };
    assert.deepEqual(
      {
        restore: await outcomeOf("restore:cas"),
        lint: await outcomeOf("lint"),
        invalid: await outcomeOf("restore:invalid"),
      },
      {
        restore: {
          status: "done",
          log:
            "::warning title=restore%3Acas::Failed to restore: EACCES: permission denied, copyfile\n" +
            "Cache not found for input keys: cas-1, cas-\n",
        },
        lint: { status: "done", log: "" },
        invalid: "Key Validation Error: in,valid cannot contain commas.",
      },
    );
  });
});
