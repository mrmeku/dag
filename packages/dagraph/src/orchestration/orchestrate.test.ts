import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";

import type { ThrottledSchedulerOptions } from "../schedulers/index.ts";
import { throttledScheduler, unboundedScheduler } from "../schedulers/index.ts";
import { errorMessage } from "./errors.ts";
import { orchestrate } from "./orchestrate.ts";
import type { Clock, RunNode } from "./ports.ts";
import type { Result, ScheduledNode } from "./types.ts";

/** What a node of the harness made: whether it ran or was a hit. */
type Made = "ran" | "hit";

const clock: Clock = { epochMilliseconds: () => 0 };

// Orchestration schedules node data alone: no kind, no action and nothing processing reads.
const node = (name: string, deps: string[] = [], concurrencyGroup?: string): ScheduledNode => ({
  name,
  deps,
  ...(concurrencyGroup && { concurrencyGroup }),
});

const idle = () => new Promise((r) => setImmediate(r));

// A miss awaits its gate and then runs until the test finishes it by hand; a hit settles at once.
// `idle` waits for a macrotask, which comes only after every queued microtask has run, so the
// scheduler has done all it would do on its own.
function harness(
  nodes: ScheduledNode[],
  opts: ThrottledSchedulerOptions,
  { hits = [], slowLookups = [] }: { hits?: string[]; slowLookups?: string[] } = {},
) {
  const log: string[] = [];
  const finishers = new Map<string, () => void>();
  const lookups = new Map<string, () => void>();
  const run: RunNode<ScheduledNode, Made, never, never> = async (n, _, waitForScheduler) => {
    if (hits.includes(n.name)) return { name: n.name, status: "succeeded", details: "hit" };
    if (slowLookups.includes(n.name))
      await new Promise<void>((resolve) => lookups.set(n.name, resolve));
    await waitForScheduler();
    log.push(`granted ${n.name}`);
    await new Promise<void>((resolve) => finishers.set(n.name, resolve));
    return { name: n.name, status: "succeeded", details: "ran" };
  };
  const done = orchestrate(nodes, run, throttledScheduler(opts), clock, (e) => {
    if (e.type === "dispatch") log.push(`dispatch ${e.node}`);
    if (e.type === "result")
      log.push(`${e.result.status === "succeeded" ? e.result.details : e.result.status} ${e.node}`);
  });
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
  return { log, done, finish, look };
}

/** A `RunNode` that settles each node at once: `failed` for the names in `failing`. */
const settleAtOnce =
  (failing: string[] = []): RunNode<ScheduledNode, Made, never, never> =>
  async (n) =>
    failing.includes(n.name)
      ? { name: n.name, status: "failed", error: { name: "Error", message: "boom" } }
      : { name: n.name, status: "succeeded", details: "ran" };

describe("orchestrate", () => {
  test("a dependent is dispatched as soon as its deps settle, while another root still runs", async () => {
    const h = harness(
      [
        node("slow_root"),
        node("fast_root"),
        node("slow_child", ["slow_root"]),
        node("fast_child", ["fast_root"]),
      ],
      {},
    );
    await idle();
    await h.finish("fast_root", "fast_child", "slow_root", "slow_child");
    await h.done;
    expect(h.log.filter((line) => !line.startsWith("granted"))).toEqual([
      "dispatch slow_root",
      "dispatch fast_root",
      "ran fast_root",
      "dispatch fast_child",
      "ran fast_child",
      "ran slow_root",
      "dispatch slow_child",
      "ran slow_child",
    ]);
  });

  test("with one place, a settled node's dependents go before ready nodes queued earlier, and nodes made ready together go in the order given", async () => {
    const order = async (nodes: ScheduledNode[], finishing: string[]) => {
      const h = harness(nodes, { maxParallelism: 1 });
      await idle();
      await h.finish(...finishing);
      await h.done;
      return h.log.filter((line) => line.startsWith("dispatch"));
    };
    expect({
      dependentsFirst: await order(
        [node("first_root"), node("second_root"), node("child", ["first_root"])],
        ["first_root", "child", "second_root"],
      ),
      givenOrder: await order(
        [node("root"), node("c1", ["root"]), node("c2", ["root"]), node("c3", ["root"])],
        ["root", "c1", "c2", "c3"],
      ),
    }).toEqual({
      dependentsFirst: ["dispatch first_root", "dispatch child", "dispatch second_root"],
      givenOrder: ["dispatch root", "dispatch c1", "dispatch c2", "dispatch c3"],
    });
  });

  test("a failure holds back what requires it, transitively and through a diamond, and nothing else", async () => {
    const results = await orchestrate(
      [
        node("good_root"),
        node("good_child", ["good_root"]),
        node("bad_root"),
        node("mid", ["bad_root"]),
        node("leaf", ["mid"]),
        node("top"),
        node("left", ["top"]),
        node("right", ["top"]),
        node("bottom", ["left", "right"]),
      ],
      settleAtOnce(["bad_root", "left"]),
      unboundedScheduler(),
      clock,
    );
    expect(
      Object.fromEntries(
        results.map((r) => [r.name, r.status === "dep-failed" ? [r.status, r.dep] : [r.status]]),
      ),
    ).toEqual({
      good_root: ["succeeded"],
      good_child: ["succeeded"],
      bad_root: ["failed"],
      mid: ["dep-failed", "bad_root"],
      leaf: ["dep-failed", "mid"],
      top: ["succeeded"],
      left: ["failed"],
      right: ["succeeded"],
      bottom: ["dep-failed", "left"],
    });
  });

  test("a held back node names its root causes: through held back required deps to those that did not succeed, each once, in dep order, never a settled dep", async () => {
    const results = await orchestrate(
      [
        node("bad"),
        node("worse"),
        node("mid", ["bad"]),
        node("leaf", ["mid", "worse", "bad"]),
        { ...node("tolerant", ["worse", "mid"]), settledDeps: ["worse"] },
      ],
      settleAtOnce(["bad", "worse"]),
      unboundedScheduler(),
      clock,
    );
    const held = { status: "dep-failed" } as const;
    expect(
      Object.fromEntries(results.filter((r) => r.status === "dep-failed").map((r) => [r.name, r])),
    ).toEqual({
      mid: { name: "mid", ...held, dep: "bad", rootCauses: ["bad"] },
      leaf: { name: "leaf", ...held, dep: "mid", rootCauses: ["bad", "worse"] },
      tolerant: { name: "tolerant", ...held, dep: "mid", rootCauses: ["bad"] },
    });
  });

  test("a cancel settles each node not yet dispatched cancelled, never dispatches its dependents, and rejects a pending node's wait for its slot", async () => {
    const controller = new AbortController();
    const aborted = new Promise((resolve) => controller.signal.addEventListener("abort", resolve));
    const ran: string[] = [];
    const run: RunNode<ScheduledNode, Made, never, never> = async (n, _, waitForScheduler) => {
      await waitForScheduler();
      ran.push(n.name);
      // The running node returns normally once cancelled, as a command that exits 0 on SIGINT does.
      if (n.name === "holder") await aborted;
      return { name: n.name, status: "succeeded", details: "ran" };
    };
    const dispatched: string[] = [];
    const results = await orchestrate(
      [
        node("holder", [], "heavy"),
        node("waiter", [], "heavy"),
        node("quick"),
        node("after", ["quick"]),
        node("never", ["holder"]),
      ],
      run,
      throttledScheduler({ concurrencyLimits: { heavy: 1 } }),
      clock,
      (e) => {
        if (e.type === "dispatch") dispatched.push(e.node);
        if (e.type === "result" && e.node === "quick") controller.abort();
      },
      controller.signal,
    );
    expect({
      ran,
      dispatched,
      statuses: Object.fromEntries(results.map((r) => [r.name, r.status])),
    }).toEqual({
      ran: ["holder", "quick"],
      dispatched: ["holder", "waiter", "quick"],
      statuses: {
        holder: "succeeded",
        waiter: "cancelled",
        quick: "succeeded",
        after: "cancelled",
        never: "cancelled",
      },
    });
  });

  test("refuses nodes whose deps it was not given, naming them", async () => {
    const nodes = [node("a", ["x"]), node("b"), node("c", ["y", "b", "z"])];
    const refused = await orchestrate(nodes, settleAtOnce(), unboundedScheduler(), clock).catch(
      (e: unknown) => errorMessage(e),
    );
    expect(refused).toBe(
      'orchestrate: nodes depend on nodes it was not given: "a" needs "x"; "c" needs "y", "z"',
    );
  });

  test("refuses node data with a cycle, naming the first one by its nodes, before any node runs", async () => {
    const refusal = (nodes: ScheduledNode[]) => {
      const ran: string[] = [];
      const run: RunNode<ScheduledNode, Made, never, never> = async (n) => {
        ran.push(n.name);
        return { name: n.name, status: "succeeded", details: "ran" };
      };
      return orchestrate(nodes, run, unboundedScheduler(), clock).then(
        () => ({ refused: "resolved", ran }),
        (e: unknown) => ({ refused: errorMessage(e), ran }),
      );
    };
    const refused = (path: string) => ({
      refused: `orchestrate: nodes depend on each other in a cycle: ${path}`,
      ran: [],
    });
    expect({
      itself: await refusal([node("root"), node("a", ["a"])]),
      through: await refusal([
        node("root"),
        node("a", ["root", "b"]),
        node("b", ["c"]),
        node("c", ["a"]),
        node("d", ["d"]),
      ]),
      diamond: await refusal([
        node("top"),
        node("left", ["top"]),
        node("right", ["top"]),
        node("bottom", ["left", "right"]),
      ]),
    }).toEqual({
      itself: refused('"a" needs "a"'),
      through: refused('"a" needs "b" needs "c" needs "a"'),
      diamond: { refused: "resolved", ran: ["top", "left", "right", "bottom"] },
    });
  });

  test("an onEvent that throws stops nothing: the nodes settle, then orchestrate rejects with its first error, and leaves no listener on the signal", async () => {
    const ran: string[] = [];
    const controller = new AbortController();
    const outcome = await orchestrate(
      [node("a"), node("b", ["a"])],
      (n) => {
        ran.push(n.name);
        return settleAtOnce()(n, {}, async () => {});
      },
      unboundedScheduler(),
      clock,
      (event) => {
        if (event.type === "dispatch" && event.node === "a") throw new Error("dispatch of a");
        if (event.type === "result" && event.node === "b") throw new Error("result of b");
      },
      controller.signal,
    ).then(
      () => "resolved",
      (e: unknown) => errorMessage(e),
    );
    expect({
      outcome,
      ran,
      listeners: getEventListeners(controller.signal, "abort").length,
    }).toEqual({ outcome: "dispatch of a", ran: ["a", "b"], listeners: 0 });
  });

  test("a RunNode that rejects settles its node failed, its cause kept as JSON and with no details, since nothing reported one, or cancelled once the execution is cancelled", async () => {
    const controller = new AbortController();
    const run: RunNode<ScheduledNode, Made, never, never> = async (n) => {
      if (n.name === "later") controller.abort();
      throw new RangeError(`${n.name} broke`, { cause: { code: 1 } });
    };
    const later: ScheduledNode = { ...node("later", ["first"]), settledDeps: ["first"] };
    const results: Result<Made, never, never>[] = await orchestrate(
      [node("first"), later],
      run,
      unboundedScheduler(),
      clock,
      undefined,
      controller.signal,
    );
    expect(results).toEqual([
      {
        name: "first",
        status: "failed",
        error: { name: "RangeError", message: "first broke", cause: { code: 1 } },
      },
      { name: "later", status: "cancelled" },
    ]);
  });
});

describe("orchestrate with throttledScheduler in its port", () => {
  test("a hit does not wait for its group's slot, and a miss waiting for one gives its place back", async () => {
    const h = harness(
      [
        node("holder", [], "heavy"),
        node("waiter", [], "heavy"),
        node("hit", [], "heavy"),
        node("free"),
      ],
      { maxParallelism: 2, concurrencyLimits: { heavy: 1 } },
      { hits: ["hit"] },
    );
    await idle();
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
        "hit hit",
        "dispatch free",
        "granted free",
      ],
      afterHolder: ["ran holder", "granted waiter"],
    });
  });

  test("an ungrouped miss keeps its place through waitForScheduler, so ready nodes ahead of it in order do not take it", async () => {
    const h = harness(
      [node("u"), node("s"), node("t", ["u"]), node("v", ["u"])],
      { maxParallelism: 2 },
      { slowLookups: ["s"] },
    );
    await idle();
    await h.finish("u");
    await h.look("s");
    const whileSRuns = [...h.log];
    await h.finish("t", "s", "v");
    await h.done;
    expect(whileSRuns).toEqual([
      "dispatch u",
      "dispatch s",
      "granted u",
      "ran u",
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
        node("heavy_a", ["root_a"], "heavy"),
        node("heavy_b", ["root_b"], "heavy"),
        node("heavy_c", ["root_c"], "heavy"),
      ],
      { concurrencyLimits: { heavy: 1 } },
    );
    await idle();
    await h.finish("root_c", "root_b", "root_a", "heavy_c");
    const grants = h.log.filter((line) => line.startsWith("granted heavy"));
    await h.finish("heavy_a", "heavy_b");
    await h.done;
    expect(grants).toEqual(["granted heavy_c", "granted heavy_a"]);
  });
});
