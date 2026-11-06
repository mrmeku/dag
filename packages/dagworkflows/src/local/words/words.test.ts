import type { ExecutionEvent, JsonValue, Node, NodeResult } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  initialRunState,
  runReducer,
  selectors,
  type FailedNodeState,
  type RunState,
} from "../../kernel/index.ts";
import {
  failureBlockLines,
  localRerunCommand,
  nameWidth,
  padName,
  recapLines,
  type LocalContext,
} from "./index.ts";

const nodeNamed = (name: string, more: Partial<Node> = {}): Node => ({
  name,
  kind: name,
  deps: [],
  ...more,
});

type Settled<R = NodeResult> = R extends unknown ? Omit<R, "name"> : never;

/** A run of `nodes` that heard `events`, each settled node's log read as `logs` gives it. */
function runOf(nodes: Node[], events: ExecutionEvent[], logs: Record<string, string[]>): RunState {
  let run = runReducer(initialRunState, { type: "passBegun", pass: { title: "ci.ts", nodes } });
  for (const event of events) run = runReducer(run, event);
  for (const [name, log] of Object.entries(logs)) {
    const settled = run.nodes.get(name);
    assert.ok(settled && selectors.isSettled(settled), `${name} settled`);
    run = runReducer(run, { type: "logRead", settled, log });
  }
  return run;
}

const ranAndSettled = (node: Node, result: Settled): ExecutionEvent[] => [
  { type: "dispatch", node: node.name, occurredAt: 0 },
  { type: "start", node: node.name, occurredAt: 0 },
  { type: "result", node: node.name, result: { name: node.name, ...result }, occurredAt: 0 },
];

const failure = (
  message: string,
  cause: JsonValue | undefined,
  details: NonNullable<Extract<NodeResult, { status: "failed" }>["details"]>,
): Settled => ({
  status: "failed",
  error: { name: "Error", message, ...(cause !== undefined && { cause }) },
  details,
});

const plain: LocalContext = {
  // Only a node that started has a log file.
  logFile: (name) =>
    ["lint docs", "hang", "spawn"].includes(name) ? `.dag/logs/${name}.log` : undefined,
  workflowFile: "ci flows.ts",
  failuresReportPath: ".dag/failures.md",
  logDir: ".dag/logs",
  summaryPath: ".dag/summary.md",
  paint: (_style, text) => text,
  link: (path) => path,
};

describe("local words", () => {
  test("names pad to terminal columns and are never cut", () => {
    assert.deepEqual(
      {
        width: nameWidth(["lint", "日本語"]),
        padded: padName("lint", 6),
        wide: padName("日本語", 8),
        whole: padName("integration:packages-dagworkflows-e2e", 24),
      },
      {
        width: 6,
        padded: "lint  ",
        wide: "日本語  ",
        whole: "integration:packages-dagworkflows-e2e",
      },
    );
  });

  test("a failure's block in each of its endings, for a workflow file holding a space", () => {
    const lint = nodeNamed("lint docs");
    const hang = nodeNamed("hang", { timeoutMs: 6 });
    const upload = nodeNamed("upload");
    const spawn = nodeNamed("spawn");
    const keyed = nodeNamed("keyed");
    const lintLog = [
      "linting",
      ...Array.from({ length: 70 }, (_, i) => `src/a${i + 1}.ts:1:1\terror`),
      `\x1b[1m${"=".repeat(600)}\x1b[22m`,
    ];
    const run = runOf(
      [lint, hang, upload, spawn, keyed],
      [
        ...ranAndSettled(
          lint,
          failure(
            "awk exited 1",
            { argv: ["awk", "/``/ { print }", "docs/a.md"], cwd: ".", ended: "exited", code: 1 },
            { actionKey: "kl", elapsed: 2900 },
          ),
        ),
        // It traps the signal its timeout sends and exits 0.
        ...ranAndSettled(
          hang,
          failure(
            "TimeoutError",
            { argv: ["hang"], cwd: ".", ended: "exited", code: 0 },
            { actionKey: "kh", elapsed: 6, timedOut: true },
          ),
        ),
        // A cause shaped like a command's but for its cwd: no command.
        ...ranAndSettled(
          upload,
          failure(
            "upload refused",
            { argv: ["curl", "-f", "s3://b"], code: 22 },
            { actionKey: "ku", elapsed: 1 },
          ),
        ),
        ...ranAndSettled(
          spawn,
          failure(
            "could not start spawn. Check that it is on the command's PATH and that its cwd exists.",
            { argv: ["spawn"], cwd: "pkg", ended: "not-started", code: -1 },
            { actionKey: "ks", elapsed: 1 },
          ),
        ),
        // Its key needs a file that is not there, so its action never ran.
        { type: "dispatch", node: "keyed", occurredAt: 0 },
        {
          type: "result",
          node: "keyed",
          result: {
            name: "keyed",
            status: "failed",
            error: { name: "Error", message: "ENOENT: src/a.ts" },
          },
          occurredAt: 0,
        },
      ],
      { "lint docs": lintLog, hang: ["waiting"], upload: [], spawn: ["spawn spawn ENOENT"] },
    );
    const blockOf = (name: string) => {
      const nodeState = run.nodes.get(name);
      assert.ok(nodeState?.status === "failed", `${name} failed`);
      const failed: FailedNodeState = nodeState;
      return failureBlockLines(failed, run, plain, failed.log ?? []);
    };
    assert.deepEqual(
      {
        command: localRerunCommand("ci flows.ts"),
        lint: blockOf("lint docs"),
        hang: blockOf("hang"),
        upload: blockOf("upload"),
        spawn: blockOf("spawn"),
        keyed: blockOf("keyed"),
      },
      {
        command: "npx --no dag run 'ci flows.ts'",
        lint: [
          "✖︎ lint docs  exit 1 · 2.9s · 72 lines",
          "│ … 52 earlier lines",
          ...Array.from({ length: 19 }, (_, i) => `│ src/a${i + 52}.ts:1:1\terror`),
          `│ ${"=".repeat(500)}…`,
          "├ log    .dag/logs/lint docs.log",
          "├ cmd    awk '/``/ { print }' docs/a.md   (cwd .)",
          "└ rerun  npx --no dag run 'ci flows.ts' --only 'lint docs'",
        ],
        hang: [
          "✖︎ hang  timed out · 0.0s · 1 line",
          "│ waiting",
          "│ The action 'hang' has timed out after 6ms.",
          "├ log    .dag/logs/hang.log",
          "├ cmd    hang   (cwd .)",
          "└ rerun  npx --no dag run 'ci flows.ts' --only hang",
        ],
        upload: [
          "✖︎ upload  0.0s",
          "│ upload refused",
          "└ rerun  npx --no dag run 'ci flows.ts' --only upload",
        ],
        spawn: [
          "✖︎ spawn  0.0s · 1 line",
          "│ spawn spawn ENOENT",
          "│ could not start spawn. Check that it is on the command's PATH and that its cwd exists.",
          "├ log    .dag/logs/spawn.log",
          "├ cmd    spawn   (cwd pkg)",
          "└ rerun  npx --no dag run 'ci flows.ts' --only spawn",
        ],
        keyed: [
          "✖︎ keyed  not started",
          "│ ENOENT: src/a.ts",
          "└ rerun  npx --no dag run 'ci flows.ts' --only keyed",
        ],
      },
    );
  });

  test("without a workflow file, neither a failure's block nor the recap has a rerun line", () => {
    const lint = nodeNamed("lint docs");
    const run = runOf(
      [lint],
      ranAndSettled(
        lint,
        failure(
          "lint exited 1",
          { argv: ["lint"], cwd: ".", ended: "exited", code: 1 },
          { actionKey: "kl", elapsed: 1000 },
        ),
      ),
      { "lint docs": ["src/a.ts: error"] },
    );
    const noWorkflowFile: LocalContext = { ...plain, workflowFile: undefined };
    const nodeState = run.nodes.get("lint docs");
    assert.ok(nodeState?.status === "failed", "lint docs failed");
    assert.deepEqual(
      {
        block: failureBlockLines(nodeState, run, noWorkflowFile, nodeState.log ?? []),
        recap: recapLines(run, noWorkflowFile),
      },
      {
        block: [
          "✖︎ lint docs  exit 1 · 1.0s · 1 line",
          "│ src/a.ts: error",
          "├ log    .dag/logs/lint docs.log",
          "└ cmd    lint   (cwd .)",
        ],
        recap: [
          "",
          "✖︎ lint docs failed · run · wall 1.0s",
          "built 0 · cached 0 · failed 1 · skipped 0",
          "",
          "✖︎ lint docs   exit 1 · 1.0s · 1 line   .dag/logs/lint docs.log",
          "",
          "report   .dag/failures.md",
          "logs     .dag/logs/",
        ],
      },
    );
  });
});
