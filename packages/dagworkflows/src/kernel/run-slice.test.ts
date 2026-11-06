import type { Node, NodeResult } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  completedLines,
  initialRunState,
  runReducer,
  type RunAction,
  type RunState,
} from "./index.ts";

const node = (name: string): Node => ({ name, kind: name, deps: [] });
const [a, b] = [node("a"), node("b")];
const entry = { outputs: {}, contentHash: "h", outputHashes: {} };
const built: NodeResult = {
  name: "a",
  status: "succeeded",
  details: { actionKey: "ka", entry, actionRan: true, elapsed: 500 },
};
const hit: NodeResult = {
  name: "a",
  status: "succeeded",
  details: { actionKey: "ka", entry, actionRan: false },
};
const at = (occurredAt: number) => ({ node: "a", occurredAt });
const result = (settled: NodeResult, occurredAt: number): RunAction => ({
  type: "result",
  node: settled.name,
  result: settled,
  occurredAt,
});
const lines = { unfinishedLine: "", lastLine: "", printed: false };
const stateAfter = (actions: RunAction[], from: RunState = initialRunState) =>
  actions.reduce(runReducer, from);
const begun = (...nodes: Node[]): RunAction => ({
  type: "passBegun",
  pass: { title: "main", nodes },
});

describe("run reducer", () => {
  test("each node path, and where its time starts", () => {
    const pathOf = (actions: RunAction[]) => {
      const states = actions.map((_, i) => stateAfter([begun(a), ...actions.slice(0, i + 1)]));
      return {
        statuses: states.map((state) => state.nodes.get("a")?.status),
        final: states.at(-1)?.nodes.get("a"),
      };
    };
    const cancelledBeforeElapsed: NodeResult = {
      name: "a",
      status: "cancelled",
      details: { actionKey: "ka" },
    };
    const failedUnkeyed: NodeResult = {
      name: "a",
      status: "failed",
      error: { name: "Error", message: "ENOENT: src/a.ts" },
    };
    assert.deepEqual(
      {
        heldMiss: pathOf([
          { type: "dispatch", ...at(1000) },
          { type: "pending", ...at(2000) },
          { type: "start", ...at(3000) },
          { type: "output", chunk: "a out\npart", ...at(3500) },
          result(built, 4000),
        ]),
        hit: pathOf([{ type: "dispatch", ...at(1000) }, result(hit, 1500)]),
        cancelledAfterItsStartWasRecorded: pathOf([
          { type: "dispatch", ...at(1000) },
          { type: "start", ...at(2000) },
          result(cancelledBeforeElapsed, 3000),
        ]),
        failedBeforeItsKey: pathOf([
          { type: "dispatch", ...at(1000) },
          result(failedUnkeyed, 2000),
        ]),
      },
      {
        heldMiss: {
          statuses: ["dispatched", "pending", "running", "running", "succeeded"],
          // The last line, left unfinished, ends with the command.
          final: {
            node: a,
            status: "succeeded",
            result: built,
            startedAt: 3000,
            endedAt: 4000,
            unfinishedLine: "",
            lastLine: "part",
            printed: true,
          },
        },
        hit: {
          statuses: ["dispatched", "succeeded"],
          final: {
            ...lines,
            node: a,
            status: "succeeded",
            result: hit,
            startedAt: 1000,
            endedAt: 1500,
          },
        },
        cancelledAfterItsStartWasRecorded: {
          statuses: ["dispatched", "running", "cancelled"],
          final: {
            ...lines,
            node: a,
            status: "cancelled",
            result: cancelledBeforeElapsed,
            endedAt: 3000,
          },
        },
        failedBeforeItsKey: {
          statuses: ["dispatched", "failed"],
          final: { ...lines, node: a, status: "failed", result: failedUnkeyed, endedAt: 2000 },
        },
      },
    );
  });

  test("a pass takes up only its nodes: an event for another is ignored, a post pass puts its owed node back to pending, and an earlier settle's log no longer lands", () => {
    const ran = stateAfter([
      begun(a),
      { type: "dispatch", node: "b", occurredAt: 1000 },
      { type: "dispatch", ...at(1000) },
      result(hit, 2000),
    ]);
    const settledA = ran.nodes.get("a");
    assert.ok(settledA?.status === "succeeded");
    const post = stateAfter(
      [begun(b, a), { type: "logRead", settled: settledA, log: ["late"] }],
      ran,
    );
    assert.deepEqual(
      { ranNodes: [...ran.nodes.keys()], post: [...post.nodes.values()] },
      {
        ranNodes: ["a"],
        post: [
          { ...lines, node: a, status: "pending" },
          { ...lines, node: b, status: "pending" },
        ],
      },
    );
  });

  test("the run's lifecycle: a cancel only while running, and a final state never changes", () => {
    const lifecycleAfter = (...actions: RunAction[]) => stateAfter(actions).lifecycle;
    assert.deepEqual(
      {
        finished: lifecycleAfter({ type: "runClosed" }, { type: "runCancelled" }),
        cancelled: lifecycleAfter({ type: "runCancelled" }, { type: "runClosed" }),
        erroredWhileCancelling: lifecycleAfter(
          { type: "runCancelled" },
          { type: "runErrored", error: "disk full" },
          { type: "runClosed" },
        ),
        interrupted: lifecycleAfter(
          { type: "runInterrupted" },
          { type: "runCancelled" },
          { type: "runClosed" },
        ),
        cancelling: lifecycleAfter({ type: "runCancelled" }, { type: "runCancelled" }),
      },
      {
        finished: { status: "finished" },
        cancelled: { status: "cancelled" },
        erroredWhileCancelling: { status: "errored", error: "disk full" },
        interrupted: { status: "interrupted" },
        cancelling: { status: "cancelling" },
      },
    );
  });

  test("output as a terminal leaves it", () => {
    const feed = (chunks: string[]) => {
      const completed: string[] = [];
      let state = stateAfter([begun(node("n"))]);
      for (const chunk of chunks) {
        completed.push(...completedLines(state.nodes.get("n")?.unfinishedLine ?? "", chunk));
        state = runReducer(state, { type: "output", node: "n", chunk, occurredAt: 0 });
      }
      const nodeState = state.nodes.get("n");
      return {
        completed,
        unfinishedLine: nodeState?.unfinishedLine,
        lastLine: nodeState?.lastLine,
      };
    };
    const redraw = (i: number) => `${i + 1} of 10000 ###`;
    assert.deepEqual(
      {
        blank: feed(["a\n", "\n", "b\n"]),
        progress: feed(["downloading 10%\rdownloading 90%\r", "done\r\n"]),
        redrawsLeading: feed(Array.from({ length: 10_000 }, (_, i) => `\r${redraw(i)}`)),
        redrawsTrailing: feed([
          ...Array.from({ length: 10_000 }, (_, i) => `${redraw(i)}\r`),
          "done",
        ]),
        redrawsAfterNewline: feed([
          `start\n${Array.from({ length: 20 }, (_, i) => `${i + 1}/20 ###\r`).join("")}`,
        ]),
        splitEscape: feed(["abc\x1b[3", "1mred\x1b[0m\n"]),
        controls: feed(["step\u0085done\x07\tok\n", "soft­hyphen\n"]),
        debug: feed(["tsc ok\n::debug::walking src\n", "::debug::walking lib"]),
        unfinished: feed(["compiling\n", "50%"]),
        warning: feed(["building\n", "::warning title=build::careful\n"]),
      },
      {
        blank: { completed: ["a", "", "b"], unfinishedLine: "", lastLine: "b" },
        progress: { completed: ["done"], unfinishedLine: "", lastLine: "done" },
        redrawsLeading: { completed: [], unfinishedLine: "10000 of 10000 ###", lastLine: "" },
        redrawsTrailing: { completed: [], unfinishedLine: "done", lastLine: "" },
        redrawsAfterNewline: {
          completed: ["start"],
          unfinishedLine: "20/20 ###\r",
          lastLine: "start",
        },
        splitEscape: { completed: ["abcred"], unfinishedLine: "", lastLine: "abcred" },
        controls: {
          completed: ["stepdone\tok", "soft­hyphen"],
          unfinishedLine: "",
          lastLine: "soft­hyphen",
        },
        debug: {
          completed: ["tsc ok"],
          unfinishedLine: "::debug::walking lib",
          lastLine: "tsc ok",
        },
        unfinished: { completed: ["compiling"], unfinishedLine: "50%", lastLine: "compiling" },
        // The terminal prints a warning apart, so it is never a node's last line.
        warning: {
          completed: ["building", "::warning title=build::careful"],
          unfinishedLine: "",
          lastLine: "building",
        },
      },
    );
  });
});
