import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";

import {
  errorMessage,
  type Ready,
  type ScheduledNode,
  type Scheduler,
  type SchedulerContext,
} from "../orchestration/index.ts";
import { throttledScheduler, unboundedScheduler, type ThrottledSchedulerOptions } from "./index.ts";

const node = (name: string, concurrencyGroup?: string): ScheduledNode => ({
  name,
  deps: [],
  ...(concurrencyGroup && { concurrencyGroup }),
});

const idle = () => new Promise((r) => setImmediate(r));

/**
 * A `SchedulerContext` the test drives by hand. `run` logs `dispatch` for a ready node and
 * `admit` for a pending one, and holds the node's place until the test settles it or, for a node
 * in a group, makes it pend: it gives its place back and is ready again, pending, at the front.
 */
function schedulerContext(nodes: ScheduledNode[]) {
  const ready: Ready[] = nodes.map((n) => ({ node: n, pending: false }));
  const log: string[] = [];
  const places = new Map<string, () => void>();
  const processing = new Set<string>();
  let wake = () => {};
  const ctx: SchedulerContext = {
    take(filter) {
      const index = filter ? ready.findIndex(filter) : 0;
      return index === -1 ? null : (ready.splice(index, 1)[0] ?? null);
    },
    run({ node: n, pending }) {
      log.push(`${pending ? "admit" : "dispatch"} ${n.name}`);
      processing.add(n.name);
      return new Promise((resolve) => places.set(n.name, resolve));
    },
    hasWork: () => ready.length > 0 || processing.size > 0,
    workAvailable: () =>
      processing.size === 0 ? Promise.resolve() : new Promise((resolve) => (wake = resolve)),
  };
  const givePlaceBack = (name: string) => {
    const resolve = places.get(name);
    assert.ok(resolve, `${name} holds no place`);
    places.delete(name);
    resolve();
  };
  return {
    log,
    start: (scheduler: Scheduler) => scheduler(ctx),
    async settle(...names: string[]) {
      for (const name of names) {
        givePlaceBack(name);
        processing.delete(name);
        wake();
        await idle();
      }
    },
    async pend(...names: string[]) {
      for (const name of names) {
        const pending = nodes.find((n) => n.name === name);
        assert.ok(pending?.concurrencyGroup, `${name} is in no group, so it never pends`);
        givePlaceBack(name);
        ready.unshift({ node: pending, pending: true });
        wake();
        await idle();
      }
    },
  };
}

describe("unboundedScheduler", () => {
  test("dispatches every ready node at once, and admits every pending one", async () => {
    const s = schedulerContext([node("a", "heavy"), node("b", "heavy"), node("c")]);
    const done = s.start(unboundedScheduler());
    await idle();
    await s.pend("a", "b");
    await s.settle("a", "b", "c");
    await done;
    expect(s.log).toEqual(["dispatch a", "dispatch b", "dispatch c", "admit a", "admit b"]);
  });
});

describe("throttledScheduler", () => {
  test("no more than maxParallelism nodes hold a place, and a place freed is filled at once", async () => {
    const s = schedulerContext([node("a"), node("b"), node("c"), node("d")]);
    const done = s.start(throttledScheduler({ maxParallelism: 2 }));
    await idle();
    const atStart = [...s.log];
    await s.settle("b");
    const afterB = s.log.slice(atStart.length);
    await s.settle("a", "c", "d");
    await done;
    expect({ atStart, afterB }).toEqual({
      atStart: ["dispatch a", "dispatch b"],
      afterB: ["dispatch c"],
    });
  });

  test("a node in a group holds its slot from its admission until it settles; while it waits for the slot it gives its place back", async () => {
    const s = schedulerContext([node("h1", "heavy"), node("h2", "heavy"), node("free")]);
    const done = s.start(
      throttledScheduler({ maxParallelism: 2, concurrencyLimits: { heavy: 1 } }),
    );
    await idle();
    await s.pend("h1", "h2");
    const whileH1HoldsTheSlot = [...s.log];
    await s.settle("h1");
    const afterH1 = s.log.slice(whileH1HoldsTheSlot.length);
    await s.settle("free", "h2");
    await done;
    expect({ whileH1HoldsTheSlot, afterH1 }).toEqual({
      whileH1HoldsTheSlot: ["dispatch h1", "dispatch h2", "admit h1", "dispatch free"],
      afterH1: ["admit h2"],
    });
  });

  test("each group's limit holds on its own, and ungrouped nodes take no slot", async () => {
    const s = schedulerContext([
      node("a1", "group_a"),
      node("a2", "group_a"),
      node("b1", "group_b"),
      node("b2", "group_b"),
      node("b3", "group_b"),
      node("free1"),
      node("free2"),
    ]);
    const done = s.start(throttledScheduler({ concurrencyLimits: { group_a: 1, group_b: 2 } }));
    await idle();
    await s.pend("a1", "a2", "b1", "b2", "b3");
    const admitted = s.log.filter((line) => line.startsWith("admit"));
    await s.settle("a1", "b1", "a2", "b2", "b3", "free1", "free2");
    await done;
    expect({ dispatched: s.log.filter((line) => line.startsWith("dispatch")), admitted }).toEqual({
      dispatched: [
        "dispatch a1",
        "dispatch a2",
        "dispatch b1",
        "dispatch b2",
        "dispatch b3",
        "dispatch free1",
        "dispatch free2",
      ],
      admitted: ["admit a1", "admit b1", "admit b2"],
    });
  });

  test("refuses a limit that is not a whole number from 1, or Infinity, naming it", () => {
    const refusal = (options: ThrottledSchedulerOptions) => {
      try {
        throttledScheduler(options);
        return "accepted";
      } catch (e) {
        return e instanceof RangeError ? e.message : `not a RangeError: ${errorMessage(e)}`;
      }
    };
    const refused = (field: string, got: number) =>
      `throttledScheduler: ${field} must be a whole number from 1, or Infinity, got ${got}`;
    expect({
      zero: refusal({ maxParallelism: 0 }),
      notANumber: refusal({ maxParallelism: Number.parseInt("four") }),
      fraction: refusal({ concurrencyLimits: { whisper: 1, heavy: 1.5 } }),
      wholeOrInfinite: refusal({ maxParallelism: Infinity, concurrencyLimits: { heavy: 1 } }),
    }).toEqual({
      zero: refused("maxParallelism", 0),
      notANumber: refused("maxParallelism", NaN),
      fraction: refused("concurrencyLimits.heavy", 1.5),
      wholeOrInfinite: "accepted",
    });
  });
});
