import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";

import { MemCache, type DagFs } from "./cache.ts";
import { actionsFor } from "./define-action.ts";
import { Graph, nodeInputs, type Node } from "./graph/index.ts";
import { orchestrate, type RunNode } from "./orchestrate.ts";
import { createMemoryDagFs } from "./ports/memory-fs.ts";
import { processNode } from "./process-node.ts";
import {
  throttledScheduler,
  unboundedScheduler,
  type ThrottledSchedulerOptions,
} from "./schedulers.ts";
import type { Result } from "./types.ts";
import { errorMessage } from "./utils.ts";

// A miss awaits its gate and then runs until the test finishes it by hand; a hit settles at once.
// `idle` waits for a macrotask, which comes only after every queued microtask has run, so the
// scheduler has done all it would do on its own.
function harness(
  nodes: Node[],
  opts: ThrottledSchedulerOptions,
  { hits = [], slowLookups = [] }: { hits?: string[]; slowLookups?: string[] } = {},
) {
  const log: string[] = [];
  const finishers = new Map<string, () => void>();
  const lookups = new Map<string, () => void>();
  const run: RunNode = async (node, _depEntries, acquire) => {
    const entry = { actionKey: "k", outputs: [], contentHash: "h" };
    if (hits.includes(node.name)) return { name: node.name, status: "cached", ...entry };
    if (slowLookups.includes(node.name))
      await new Promise<void>((resolve) => lookups.set(node.name, resolve));
    await acquire();
    log.push(`granted ${node.name}`);
    await new Promise<void>((resolve) => finishers.set(node.name, resolve));
    return { name: node.name, status: "done", ...entry, elapsed: 0 };
  };
  const done = orchestrate(nodes, run, throttledScheduler(opts), (e) => {
    if (e.type === "dispatch") log.push(`dispatch ${e.node}`);
    if (e.type === "result") log.push(`${e.result.status} ${e.node}`);
  });
  const idle = () => new Promise((r) => setImmediate(r));
  const finish = async (...names: string[]) => {
    for (const name of names) {
      const resolve = finishers.get(name);
      assert.ok(resolve, `${name} is not running`);
      resolve();
      await idle();
    }
  };
  const look = async (name: string) => {
    const resolve = lookups.get(name);
    assert.ok(resolve, `${name} is not looking up`);
    resolve();
    await idle();
  };
  return { log, done, idle, finish, look };
}

const node = (name: string, concurrencyGroup?: string, deps: string[] = []): Node => ({
  name,
  kind: name,
  deps,
  ...(concurrencyGroup && { concurrencyGroup }),
});

describe("throttledScheduler", () => {
  test("a place freed under maxParallelism, or a group's slot, is filled while another node still runs", async () => {
    const place = harness([node("long"), node("a"), node("b")], { maxParallelism: 2 });
    await place.idle();
    await place.finish("a");
    const placeWhileLongRuns = [...place.log];
    await place.finish("long", "b");
    await place.done;

    const slot = harness([node("long"), node("a", "heavy"), node("b", "heavy")], {
      concurrencyLimits: { heavy: 1 },
    });
    await slot.idle();
    await slot.finish("a");
    const slotWhileLongRuns = [...slot.log];
    await slot.finish("long", "b");
    await slot.done;

    expect({ placeWhileLongRuns, slotWhileLongRuns }).toEqual({
      placeWhileLongRuns: [
        "dispatch long",
        "dispatch a",
        "granted long",
        "granted a",
        "done a",
        "dispatch b",
        "granted b",
      ],
      slotWhileLongRuns: [
        "dispatch long",
        "dispatch a",
        "dispatch b",
        "granted long",
        "granted a",
        "done a",
        "granted b",
      ],
    });
  });

  test("a hit does not wait for its group's slot, and a miss waiting for one gives its place back", async () => {
    const h = harness(
      [node("holder", "heavy"), node("waiter", "heavy"), node("hit", "heavy"), node("free")],
      { maxParallelism: 2, concurrencyLimits: { heavy: 1 } },
      { hits: ["hit"] },
    );
    await h.idle();
    const whileHolderRuns = [...h.log];
    await h.finish("holder");
    const afterHolder = h.log.slice(whileHolderRuns.length);
    await h.finish("free", "waiter");
    await h.done;
    expect({ whileHolderRuns, afterHolder }).toEqual({
      whileHolderRuns: [
        "dispatch holder",
        "dispatch waiter",
        "granted holder",
        "dispatch hit",
        "cached hit",
        "dispatch free",
        "granted free",
      ],
      afterHolder: ["done holder", "granted waiter"],
    });
  });

  test("an ungrouped miss keeps its place through acquire, so ready nodes ahead of it in order do not take it", async () => {
    const h = harness(
      [node("u"), node("s"), node("t", undefined, ["u"]), node("v", undefined, ["u"])],
      { maxParallelism: 2 },
      { slowLookups: ["s"] },
    );
    await h.idle();
    await h.finish("u");
    await h.look("s");
    const whileSRuns = [...h.log];
    await h.finish("t", "s", "v");
    await h.done;
    expect(whileSRuns).toEqual([
      "dispatch u",
      "dispatch s",
      "granted u",
      "done u",
      "dispatch t",
      "granted t",
      "granted s",
    ]);
  });

  test("misses wait for their group's slot in the engine's order, not the order they asked", async () => {
    const h = harness(
      [
        node("root_a"),
        node("root_b"),
        node("root_c"),
        node("heavy_a", "heavy", ["root_a"]),
        node("heavy_b", "heavy", ["root_b"]),
        node("heavy_c", "heavy", ["root_c"]),
      ],
      { concurrencyLimits: { heavy: 1 } },
    );
    await h.idle();
    await h.finish("root_c", "root_b", "root_a", "heavy_c");
    const grants = h.log.filter((line) => line.startsWith("granted heavy"));
    await h.finish("heavy_a", "heavy_b");
    await h.done;
    expect(grants).toEqual(["granted heavy_c", "granted heavy_a"]);
  });
});

describe("orchestrate", () => {
  const done = async (n: Node): Promise<Result> => ({
    name: n.name,
    actionKey: "k",
    status: "done",
    outputs: [],
    contentHash: "h",
    elapsed: 0,
  });

  test("refuses nodes whose deps it was not given, naming them", async () => {
    const nodes = [node("a", undefined, ["x"]), node("b"), node("c", undefined, ["y", "b", "z"])];
    const refused = await orchestrate(nodes, done, unboundedScheduler()).catch((e: unknown) =>
      errorMessage(e),
    );
    expect(refused).toBe(
      'orchestrate: nodes depend on nodes it was not given: "a" needs "x"; "c" needs "y", "z"',
    );
  });

  test("a RunNode that rejects settles its node failed with no cause, or cancelled once the execution is cancelled", async () => {
    const controller = new AbortController();
    const run: RunNode = async (n) => {
      if (n.name === "later") controller.abort();
      throw new RangeError(`${n.name} broke`, { cause: "dropped" });
    };
    const later: Node = { ...node("later", undefined, ["first"]), settledDeps: ["first"] };
    const results = await orchestrate(
      [node("first"), later],
      run,
      unboundedScheduler(),
      undefined,
      controller.signal,
    );
    expect(results).toEqual([
      {
        name: "first",
        actionKey: "",
        status: "failed",
        error: { name: "RangeError", message: "first broke" },
        elapsed: 0,
      },
      { name: "later", actionKey: "", status: "cancelled" },
    ]);
  });

  test("with processNode given no signal, a cancel still ends a miss's wait for its slot: it settles cancelled", async () => {
    const fs = createMemoryDagFs();
    const ctx = { ports: { fs }, cache: new MemCache(), fs, casBaseDir: "/cas" };
    const controller = new AbortController();
    const defineActionWithPorts = actionsFor<{ fs: DagFs }>();
    const heavy = defineActionWithPorts({
      kind: "heavy",
      nodeInputs: nodeInputs<{ id: number }>,
      concurrencyGroup: "heavy",
      action: async (c) => {
        controller.abort();
        await new Promise((r) => setTimeout(r, 10));
        await c.ports.fs.writeText(`${c.outputDir}/f`, "x");
        return `${c.outputDir}/f`;
      },
    });
    const g = new Graph<{ fs: DagFs }>();
    heavy.addNode(g, { name: "holder", inputs: { id: 1 } });
    heavy.addNode(g, { name: "waiter", inputs: { id: 2 } });
    const results = await orchestrate(
      g.describe(),
      (n, depEntries, acquire) => processNode(g, n.name, depEntries, ctx, { acquire }),
      throttledScheduler({ concurrencyLimits: { heavy: 1 } }),
      undefined,
      controller.signal,
    );
    expect(Object.fromEntries(results.map((r) => [r.name, r.status]))).toEqual({
      holder: "done",
      waiter: "cancelled",
    });
  });
});
