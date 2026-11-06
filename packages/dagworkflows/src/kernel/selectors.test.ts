import type { Node, NodeResult } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { test } from "node:test";
import { initialRunState, runReducer, selectors, type RunAction } from "./index.ts";

const node = (name: string, deps: string[] = [], settledDeps?: string[]): Node => ({
  name,
  kind: "run",
  deps,
  ...(settledDeps && { settledDeps }),
  cacheable: false,
});
const entry = { outputs: {}, contentHash: "h", outputHashes: {} };

test("a skipped node's causes are the engine's root causes: the failures along its required deps, through the skipped nodes between, and not a failed settled dep", () => {
  // What dagraph emits when `test`, `upload` and `notify` exit 1 under these deps.
  const nodes = [
    node("up:db"),
    node("test", ["up:db"]),
    node("e2e", ["test"]),
    node("deploy", ["e2e"]),
    node("upload", ["up:db", "test"], ["test"]),
    node("publish", ["upload", "test"], ["test"]),
    node("notify", ["e2e"], ["e2e"]),
  ];
  const exited = (name: string): NodeResult => ({
    name,
    status: "failed",
    error: {
      name: "Error",
      message: `${name} exited 1`,
      cause: { argv: [name], cwd: ".", ended: "exited", code: 1 },
    },
    details: { actionKey: `k-${name}`, elapsed: 1000 },
  });
  const skipped = (name: string, dep: string, rootCause: string): NodeResult => ({
    name,
    status: "dep-failed",
    dep,
    rootCauses: [rootCause],
  });
  const results: NodeResult[] = [
    {
      name: "up:db",
      status: "succeeded",
      details: { actionKey: "k-up", entry, actionRan: true, elapsed: 2000 },
    },
    exited("test"),
    skipped("e2e", "test", "test"),
    skipped("deploy", "e2e", "test"),
    exited("upload"),
    skipped("publish", "upload", "upload"),
    exited("notify"),
  ];
  const run = [
    { type: "passBegun", pass: { title: "main", nodes } } satisfies RunAction,
    ...results.map(
      (result): RunAction => ({ type: "result", node: result.name, result, occurredAt: 0 }),
    ),
  ].reduce(runReducer, initialRunState);
  const stateOf = (name: string) => {
    const nodeState = run.nodes.get(name);
    assert.ok(nodeState, name);
    return nodeState;
  };
  assert.deepEqual(
    {
      causesOfDeploy: selectors.causesOf(stateOf("deploy")),
      causesOfPublish: selectors.causesOf(stateOf("publish")),
      skippedBecauseOfTest: selectors.skippedBecauseOf(run, "test"),
      dependencyFailuresOfUpload: selectors
        .getDependencyFailures(run, stateOf("upload"))
        .map((depState) => depState.node.name),
      dependencyFailuresOfNotify: selectors
        .getDependencyFailures(run, stateOf("notify"))
        .map((depState) => depState.node.name),
    },
    {
      causesOfDeploy: ["test"],
      causesOfPublish: ["upload"],
      skippedBecauseOfTest: ["e2e", "deploy"],
      dependencyFailuresOfUpload: ["test"],
      dependencyFailuresOfNotify: ["e2e"],
    },
  );
});

test("a cache hit's duration runs from its dispatch to its result, and is at least 1 ms", () => {
  const nodes = [node("slow"), node("instant")];
  const hit = (name: string): NodeResult => ({
    name,
    status: "succeeded",
    details: { actionKey: `k-${name}`, entry, actionRan: false },
  });
  const run = (
    [
      { type: "passBegun", pass: { title: "main", nodes } },
      { type: "dispatch", node: "slow", occurredAt: 1000 },
      { type: "dispatch", node: "instant", occurredAt: 1200 },
      { type: "result", node: "instant", result: hit("instant"), occurredAt: 1200 },
      { type: "result", node: "slow", result: hit("slow"), occurredAt: 1500 },
    ] satisfies RunAction[]
  ).reduce(runReducer, initialRunState);
  assert.deepEqual(selectors.nodeReports(run), [
    { node: nodes[0], result: hit("slow"), start: 1000, duration: 500 },
    { node: nodes[1], result: hit("instant"), start: 1200, duration: 1 },
  ]);
});

test("a cause is a command's only when whole: string argv, a cwd, a code and a known ending", () => {
  const command = { argv: ["tsc"], cwd: ".", ended: "exited", code: 2 };
  const causes = [
    command,
    { argv: ["tsc"], cwd: ".", code: 2 },
    { argv: ["tsc"], cwd: ".", ended: "crashed", code: 2 },
    { argv: [1], cwd: ".", ended: "exited", code: 2 },
    { argv: ["tsc"], ended: "exited", code: 2 },
    { argv: ["tsc"], cwd: ".", ended: "exited" },
  ];
  assert.deepEqual(
    causes.map((cause) => selectors.commandOf({ cause })),
    [command, undefined, undefined, undefined, undefined, undefined],
  );
});
