import { execute, Graph, MemCache, namedOutput, type Result } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cache } from "./cache.ts";
import { addCommand } from "./commands.ts";
import type { Ports } from "./ports.ts";
import { createMemoryActionsCache } from "./ports/actions-cache.ts";
import { createTestPorts } from "./ports/memory.ts";
import { logPath } from "./steps.ts";

const CAS = "/cas";

/** Executes `graph` under `ports`, on a cache of its own unless given one. */
const executeUnder = (graph: Graph<Ports>, ports: Ports, store = new MemCache()) =>
  execute(graph, { ports, cache: store, fs: ports.fs, casBaseDir: CAS });

/** A save's `cacheId` and log once it ran, or the message it failed with. */
async function saveOutcome(fs: Ports["fs"], save: Result | undefined): Promise<unknown> {
  assert.ok(save, "a save");
  if (save.status === "failed") return save.error.message;
  assert.ok(save.status === "done", save.status);
  const cacheId: unknown = JSON.parse(await fs.readText(namedOutput(save.outputs, "cacheId")));
  return { cacheId, log: await fs.readText(logPath(CAS, save.actionKey)) };
}

describe("cache", () => {
  test("the restore logs what it found and has no outputs, so its dependent keys alike after an exact hit, a restore-key hit and a miss", async () => {
    const { ports: p, fs } = createTestPorts();
    const graph = new Graph<Ports>();
    const cas = cache(graph, { name: "cas", path: [".cas"], key: "cas-2", restoreKeys: ["cas-"] });
    addCommand(graph, {
      name: "lint",
      cmd: ["lint"],
      inputs: { version: "lint-v1" },
      deps: { cas: cas.restore },
    });
    const store = new MemCache();
    const runs = [];
    for (const held of [["cas-2"], ["cas-1"], []]) {
      const actionsCache = createMemoryActionsCache(held);
      const results = await executeUnder(graph, { ...p, actionsCache }, store);
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
      { restore: { outputs: {}, log: "Cache restored from key: cas-2\n" }, lint: "done" },
      { restore: { outputs: {}, log: "Cache restored from key: cas-1\n" }, lint: "cached" },
      {
        restore: { outputs: {}, log: "Cache not found for input keys: cas-2, cas-\n" },
        lint: "cached",
      },
    ]);
  });

  test("the save asks the service first: it saves a key the service lacks though a longer one matches it, saves nothing on a run again, and saves again once the entry is evicted", async () => {
    const service = createMemoryActionsCache(["cas-10"]);
    const { ports: p, fs } = createTestPorts({ actionsCache: service });
    const graph = new Graph<Ports>();
    cache(graph, { name: "cas", path: [".cas"], key: "cas-1" }).save();
    const store = new MemCache();
    const saveRun = async () =>
      saveOutcome(
        fs,
        (await executeUnder(graph, p, store)).find((r) => r.name === "save:cas"),
      );
    const first = await saveRun();
    const again = await saveRun();
    service.entries.delete("cas-1");
    const evicted = await saveRun();
    assert.deepEqual(
      { first, again, evicted, entries: [...service.entries] },
      {
        first: { cacheId: 2, log: "Cache saved with key: cas-1\n" },
        again: {
          cacheId: null,
          log: "Cache hit occurred on the primary key cas-1, not saving cache.\n",
        },
        evicted: { cacheId: 2, log: "Cache saved with key: cas-1\n" },
        entries: [
          ["cas-10", []],
          ["cas-1", [".cas"]],
        ],
      },
    );
  });

  test("a save whose lookup throws logs it and still saves; a refused save is a warning, not a failure; an invalid key fails it", async () => {
    const service = createMemoryActionsCache();
    const { ports: p, fs } = createTestPorts({ actionsCache: service });
    const restore = service.restoreCache;
    service.restoreCache = async (paths, key, restoreKeys, options) => {
      if (options?.lookupOnly && key === "unreachable") throw new Error("connect ECONNREFUSED");
      return restore(paths, key, restoreKeys, options);
    };
    const save = service.saveCache;
    service.saveCache = async (paths, key) => {
      if (key === "refused") throw new Error("Cache service responded with 429");
      if (key === "in,valid")
        throw Object.assign(new Error("Key Validation Error: in,valid cannot contain commas."), {
          name: "ValidationError",
        });
      return save(paths, key);
    };
    const graph = new Graph<Ports>();
    for (const [name, key] of [
      ["unreachable", "unreachable"],
      ["refused", "refused"],
      ["invalid", "in,valid"],
    ] as const)
      cache(graph, { name, path: [name], key }).save();
    const saves = (await executeUnder(graph, p)).filter((r) => r.name.startsWith("save:"));
    const outcomes = await Promise.all(
      saves.map(async (r): Promise<[string, unknown]> => [r.name, await saveOutcome(fs, r)]),
    );
    assert.deepEqual(
      {
        saves: Object.fromEntries(outcomes),
        entries: [...service.entries],
      },
      {
        saves: {
          "save:unreachable": {
            cacheId: 1,
            log:
              "Cache lookup failed, saving anyway: connect ECONNREFUSED\n" +
              "Cache saved with key: unreachable\n",
          },
          "save:refused": {
            cacheId: null,
            log: "::warning title=save%3Arefused::Failed to save: Cache service responded with 429\n",
          },
          "save:invalid": "Key Validation Error: in,valid cannot contain commas.",
        },
        entries: [["unreachable", ["unreachable"]]],
      },
    );
  });
});
