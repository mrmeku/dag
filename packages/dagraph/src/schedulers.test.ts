import { describe, expect, test } from "bun:test";

import type { Node } from "./graph/index.ts";
import { orchestrate, type RunNode } from "./orchestrate.ts";
import { throttledScheduler, type ThrottledSchedulerOptions } from "./schedulers.ts";

// Nodes run until the test finishes them by hand. `idle` waits for a macrotask, which comes only
// after every queued microtask has run, so the scheduler has done all it would do on its own.
function harness(nodes: Node[], opts: ThrottledSchedulerOptions) {
  const log: string[] = [];
  const finishers = new Map<string, () => void>();
  const run: RunNode = (node) =>
    new Promise((resolve) => {
      finishers.set(node.name, () =>
        resolve({ name: node.name, actionKey: "", status: "cancelled" }),
      );
    });
  const done = orchestrate(nodes, run, throttledScheduler(opts), (e) => {
    if (e.type === "dispatch" || e.type === "settled") log.push(`${e.type} ${e.node.name}`);
  });
  const idle = () => new Promise((r) => setImmediate(r));
  const finish = async (name: string) => {
    finishers.get(name)!();
    await idle();
  };
  return { log, done, idle, finish };
}

const node = (name: string, concurrencyGroup?: string): Node => ({
  name,
  kind: name,
  deps: [],
  config: "",
  ...(concurrencyGroup && { concurrencyGroup }),
});

describe("throttledScheduler", () => {
  test.each([
    ["maxParallelism", [node("long"), node("a"), node("b")], { maxParallelism: 2 }],
    [
      "concurrencyLimits",
      [node("long"), node("a", "heavy"), node("b", "heavy")],
      { concurrencyLimits: { heavy: 1 } },
    ],
  ] as const)(
    "a slot freed under %s is filled while another node still runs",
    async (_, nodes, opts) => {
      const h = harness([...nodes], opts);
      await h.idle();
      await h.finish("a");
      const whileLongRuns = [...h.log];
      await h.finish("long");
      await h.finish("b");
      await h.done;
      expect({ whileLongRuns, all: h.log }).toEqual({
        whileLongRuns: ["dispatch long", "dispatch a", "settled a", "dispatch b"],
        all: [
          "dispatch long",
          "dispatch a",
          "settled a",
          "dispatch b",
          "settled long",
          "settled b",
        ],
      });
    },
  );
});
