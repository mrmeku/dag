import type { Node, NodeResult } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  failureMessage,
  formatDuration,
  initialRunState,
  onlyArgument,
  reportHeadline,
  rerunLine,
  runHeadline,
  runReducer,
  scopeOf,
  type NodeReport,
  type RunAction,
} from "./index.ts";

const node = (name: string): Node => ({ name, kind: name, deps: [] });
const entry = { outputs: {}, contentHash: "h", outputHashes: {} };
const builtResult = (name: string): NodeResult => ({
  name,
  status: "succeeded",
  details: { actionKey: "k", entry, actionRan: true, elapsed: 1000 },
});
const failedResult = (name: string): NodeResult => ({
  name,
  status: "failed",
  error: { name: "Error", message: `${name} exited 1` },
  details: { actionKey: "k", elapsed: 1000 },
});
const skippedResult = (name: string): NodeResult => ({ name, status: "dep-failed", dep: "a" });
const cancelledResult = (name: string): NodeResult => ({ name, status: "cancelled" });
const reportOf = (result: NodeResult): NodeReport => ({ node: node(result.name), result });

describe("the words every display shares", () => {
  test("durations, timeouts and outcomes in a few words: a timeout is the node's own, not an error an action names one", () => {
    const failure = (timeoutMs: number, timedOut: boolean) => {
      const n = { ...node("n"), timeoutMs };
      const settled = [
        { type: "passBegun", pass: { title: "main", nodes: [n] } },
        {
          type: "result",
          node: "n",
          result: {
            name: "n",
            status: "failed",
            error: { name: "TimeoutError", message: "fetch timed out" },
            details: { actionKey: "k", elapsed: 1, ...(timedOut && { timedOut }) },
          },
          occurredAt: 0,
        },
      ] satisfies RunAction[];
      const nodeState = settled.reduce(runReducer, initialRunState).nodes.get("n");
      assert.ok(nodeState?.status === "failed");
      return failureMessage(nodeState);
    };
    assert.deepEqual(
      {
        durations: [450, 1500].map(formatDuration),
        failures: [
          failure(60_000, true),
          failure(60_001, true),
          failure(100_000, true),
          failure(60_000, false),
        ],
        skipped: failureMessage({
          node: node("d"),
          result: { name: "d", status: "dep-failed", dep: "b" },
        }),
      },
      {
        durations: ["450ms", "1.5s"],
        failures: [
          "The action 'n' has timed out after 1 minute.",
          "The action 'n' has timed out after 1 minute.",
          "The action 'n' has timed out after 1.67 minutes.",
          "fetch timed out",
        ],
        skipped: "dependency b failed",
      },
    );
  });

  test("the headline's precedence: failures, then skips, then cancels; an errored or cancelled run says so unless a node failed", () => {
    const reports = (...results: NodeResult[]) => results.map(reportOf);
    const run = (lifecycle: RunAction[], ...results: NodeResult[]) => {
      const actions: RunAction[] = [
        {
          type: "passBegun",
          pass: { title: "main", nodes: results.map(({ name }) => node(name)) },
        },
        ...results.map(
          (result): RunAction => ({ type: "result", node: result.name, result, occurredAt: 0 }),
        ),
        ...lifecycle,
      ];
      return actions.reduce(runReducer, initialRunState);
    };
    const cancel: RunAction[] = [{ type: "runCancelled" }];
    assert.deepEqual(
      {
        manyFailed: reportHeadline(
          reports(...["a", "b", "c", "d"].map(failedResult), skippedResult("e")),
        ),
        failed: reportHeadline(
          reports(failedResult("a"), skippedResult("b"), cancelledResult("c")),
        ),
        skipped: reportHeadline(reports(skippedResult("b"), cancelledResult("c"))),
        cancelled: reportHeadline(reports(builtResult("a"), cancelledResult("c"))),
        one: reportHeadline(reports(builtResult("a"))),
        all: reportHeadline(reports(builtResult("a"), builtResult("b"))),
        errored: runHeadline(
          run([{ type: "runErrored", error: "disk full\nat write" }], failedResult("a")),
        ),
        failedWhileCancelling: runHeadline(run(cancel, failedResult("a"), cancelledResult("b"))),
        cancelling: runHeadline(run(cancel, skippedResult("b"), cancelledResult("c"))),
        finished: runHeadline(run([{ type: "runClosed" }], skippedResult("b"))),
      },
      {
        manyFailed: "✖︎ a, b, c and 1 more failed",
        failed: "✖︎ a failed",
        skipped: "⏭︎ 1 node skipped, a dependency failed",
        cancelled: "◼︎ cancelled, 1 node not run",
        one: "✔︎ 1 node succeeded",
        all: "✔︎ all 2 nodes succeeded",
        errored: "✖︎ errored: disk full",
        failedWhileCancelling: "✖︎ a failed",
        cancelling: "◼︎ cancelled, 2 nodes not run",
        finished: "⏭︎ 1 node skipped, a dependency failed",
      },
    );
  });

  test("a banner's scope", () => {
    assert.deepEqual(
      [
        scopeOf(1, undefined, 1),
        scopeOf(3, [], 3),
        scopeOf(5, ["lint", "test"], 2),
        scopeOf(1, ["x"], 1),
      ],
      ["1 node", "3 nodes", "2 of 5 nodes (--only lint,test)", "1 of 1 node (--only x)"],
    );
  });

  test("the --only argument quotes, as shlex.quote does, the names a shell would split", () => {
    assert.deepEqual(
      {
        bare: onlyArgument(["test:unit", "require-all", "a/b@1.0+x=%"]),
        space: onlyArgument(["lint docs"]),
        quoteInside: onlyArgument(["a'b"]),
        quoteFirst: onlyArgument(["'a"]),
        quoteLast: onlyArgument(["a'"]),
        quotesInside: onlyArgument(["a''b"]),
        empty: onlyArgument([""]),
        rerun: rerunLine("npx --no dag run ci.ts", ["lint docs"]),
      },
      {
        bare: "--only test:unit,require-all,a/b@1.0+x=%",
        space: "--only 'lint docs'",
        quoteInside: `--only 'a'"'"'b'`,
        quoteFirst: `--only "'"'a'`,
        quoteLast: `--only 'a'"'"`,
        quotesInside: `--only 'a'"''"'b'`,
        empty: "--only ''",
        rerun: "npx --no dag run ci.ts --only 'lint docs'",
      },
    );
  });
});
