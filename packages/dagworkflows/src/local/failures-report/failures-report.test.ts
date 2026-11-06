import type { ExecutionEvent, JsonValue, Node, NodeResult } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { memoryRuntime } from "../../memory/index.ts";
import { createRecordingHost } from "../../recording/index.ts";
import { createRunStore } from "../../run-store/index.ts";
import type { SyncFileSystem } from "../../wiring/index.ts";
import type { LocalFiles } from "../words/index.ts";
import { createFailuresReport } from "./index.ts";

const nodeNamed = (name: string, deps: string[] = []): Node => ({ name, kind: name, deps });
type Settled<R = NodeResult> = R extends unknown ? Omit<R, "name"> : never;
const started = (node: Node): ExecutionEvent[] => [
  { type: "dispatch", node: node.name, occurredAt: 0 },
  { type: "start", node: node.name, occurredAt: 0 },
];
const printed = (node: Node, chunk: string): ExecutionEvent => ({
  type: "output",
  node: node.name,
  chunk,
  occurredAt: 0,
});
const settledAs = (node: Node, result: Settled): ExecutionEvent => ({
  type: "result",
  node: node.name,
  result: { name: node.name, ...result },
  occurredAt: 0,
});
const built = (node: Node) =>
  settledAs(node, {
    status: "succeeded",
    details: {
      actionKey: `k-${node.name}`,
      entry: { outputs: {}, contentHash: "h", outputHashes: {} },
      actionRan: true,
      elapsed: 1,
    },
  });
const failed = (node: Node, message: string, cause?: JsonValue) =>
  settledAs(node, {
    status: "failed",
    error: { name: "Error", message, ...(cause !== undefined && { cause }) },
    details: { actionKey: `k-${node.name}`, elapsed: 1 },
  });
const exited = (argv: string[], code: number): JsonValue => ({
  argv,
  cwd: ".",
  ended: "exited",
  code,
});

/** The report of a run on a fresh memory runtime, each node in `logged` with a log file. */
function reportRun(
  logged: string[],
  syncFs?: SyncFileSystem,
  { workflowFile }: Pick<LocalFiles, "workflowFile"> = { workflowFile: "ci.ts" },
) {
  const runtime = memoryRuntime();
  const recorded = createRecordingHost();
  const files: LocalFiles = {
    logFile: (name: string) => (logged.includes(name) ? `.dag/logs/${name}.log` : undefined),
    workflowFile,
    failuresReportPath: ".dag/failures.md",
    logDir: ".dag/logs",
    summaryPath: ".dag/summary.md",
  };
  const store = createRunStore({
    fs: runtime.fs,
    durationsFile: "/durations/ci.ts.json",
    listeners: [createFailuresReport(files, syncFs ?? runtime.syncFs, recorded.host)],
  });
  const report = () => {
    const file = runtime.fs.files.get(".dag/failures.md");
    assert.ok(file, "failures report");
    return String(file.data).split("\n");
  };
  return { store, recorded, report };
}

const TAIL = ["", "Logs: .dag/logs/ · summary: .dag/summary.md", ""];

describe("failures report", () => {
  test("rewritten as each failure comes and each node it skips, then what the run came to", async () => {
    const [install, lint, build] = [
      nodeNamed("install"),
      nodeNamed("lint", ["install"]),
      nodeNamed("build", ["install"]),
    ];
    const requireAll = nodeNamed("require-all", ["lint", "build"]);
    const deploy = nodeNamed("deploy:site", ["require-all"]);
    const upload = nodeNamed("upload", ["lint"]);
    const pack = nodeNamed("pack");
    const pass = {
      title: "ci.ts",
      nodes: [install, lint, build, requireAll, deploy, upload, pack],
    };
    const { store, report } = reportRun([
      "install",
      "lint",
      "build",
      "require-all",
      "upload",
      "pack",
    ]);
    const errors = (first: number, last: number) =>
      Array.from({ length: last - first + 1 }, (_, i) => `src/a${first + i}.ts:1:1\terror`);
    const heads = () => report().filter((line) => /^(status|## |- skipped)/.test(line));
    store.begin(pass);
    for (const event of started(install)) store.onEvent(event);
    store.onEvent(built(install));
    await store.report(pass);
    const beforeAnyFailure = report();
    for (const event of [...started(lint), ...started(build)]) store.onEvent(event);
    store.onEvent(
      printed(lint, ["linting", ...errors(1, 70), "\x1b[1m70 problems\x1b[22m"].join("\n")),
    );
    store.onEvent(failed(lint, "lint exited 1", exited(["lint"], 1)));
    store.onEvent(built(build));
    await store.report(pass);
    const afterOne = heads();
    for (const event of started(requireAll)) store.onEvent(event);
    store.onEvent(failed(requireAll, "failed: lint"));
    await store.report(pass);
    const afterTwo = heads();
    store.onEvent(
      settledAs(deploy, { status: "dep-failed", dep: "require-all", rootCauses: ["require-all"] }),
    );
    await store.report(pass);
    const afterSkip = heads();
    for (const event of [...started(upload), ...started(pack)]) store.onEvent(event);
    store.onEvent(printed(upload, "ECONNREFUSED 127.0.0.1:9000\n"));
    store.onEvent(failed(upload, "upload exited 3", exited(["upload"], 3)));
    store.onEvent(printed(pack, `packed\n${"=".repeat(600)}\n`));
    store.onEvent(
      failed(
        pack,
        'output "tarball" (pkg.tgz) was not written. Write it at out.tarball before the action returns.',
        exited(["pack"], 0),
      ),
    );
    await store.close();
    const status = "status: running · started 1970-01-01T00:00:00.000Z";
    assert.deepEqual(
      { beforeAnyFailure, afterOne, afterTwo, afterSkip, final: report() },
      {
        beforeAnyFailure: ["# Failures · ci.ts", "", status, "", "No failures so far.", ...TAIL],
        afterOne: [status, "## ✖︎ lint · exit 1 · 0.0s · 72 lines"],
        afterTwo: [status, "## ✖︎ lint · exit 1 · 0.0s · 72 lines", "## ✖︎ require-all · 0.0s"],
        afterSkip: [
          status,
          "## ✖︎ lint · exit 1 · 0.0s · 72 lines",
          "## ✖︎ require-all · 0.0s",
          "- skipped because of it: `deploy:site`",
        ],
        final: [
          "# Failures · ci.ts",
          "",
          "status: finished · started 1970-01-01T00:00:00.000Z · wall 0.0s",
          "✖︎ lint, require-all, upload and 1 more failed · built 2 · cached 0 · failed 4 · skipped 1",
          "",
          "## ✖︎ lint · exit 1 · 0.0s · 72 lines",
          "",
          "- command: `lint` (cwd `.`)",
          "- log: `.dag/logs/lint.log` (72 lines)",
          "- rerun: `npx --no dag run ci.ts --only lint`",
          "",
          "```text",
          ...errors(12, 70),
          "70 problems",
          "```",
          "",
          "## ✖︎ require-all · 0.0s",
          "",
          "- error: failed: lint",
          "- log: `.dag/logs/require-all.log` (0 lines)",
          "- dependencies that also failed: `lint`",
          "- skipped because of it: `deploy:site`",
          "- rerun: `npx --no dag run ci.ts --only require-all`",
          "",
          "## ✖︎ upload · exit 3 · 0.0s · 1 line",
          "",
          "- command: `upload` (cwd `.`)",
          "- log: `.dag/logs/upload.log` (1 line)",
          "- dependencies that also failed: `lint`",
          "- rerun: `npx --no dag run ci.ts --only upload`",
          "",
          "```text",
          "ECONNREFUSED 127.0.0.1:9000",
          "```",
          "",
          "## ✖︎ pack · 0.0s · 2 lines",
          "",
          "- command: `pack` (cwd `.`)",
          '- error: output "tarball" (pkg.tgz) was not written. Write it at out.tarball before the action returns.',
          "- log: `.dag/logs/pack.log` (2 lines)",
          "- rerun: `npx --no dag run ci.ts --only pack`",
          "",
          "```text",
          "packed",
          "=".repeat(600),
          "```",
          ...TAIL,
        ],
      },
    );
  });

  test("a forced exit while a node runs, with backticks in a command and its log", async () => {
    const lint = nodeNamed("lint docs");
    const build = nodeNamed("build");
    const requireAll = nodeNamed("require-all", ["lint docs"]);
    const deploy = nodeNamed("deploy", ["require-all"]);
    const pass = { title: "ci.ts", nodes: [lint, build, requireAll, deploy] };
    const { store, report } = reportRun(["lint docs", "build", "require-all"]);
    store.begin(pass);
    for (const event of [...started(lint), ...started(build)]) store.onEvent(event);
    store.onEvent(printed(lint, "```\nRun ``bun test`` first\n"));
    const awk = ["awk", "/``/ { print; bad = 1 } END { exit bad }", "docs/a.md"];
    store.onEvent(failed(lint, "awk exited 1", exited(awk, 1)));
    for (const event of started(requireAll)) store.onEvent(event);
    store.onEvent(failed(requireAll, "failed: lint"));
    store.onEvent(
      settledAs(deploy, { status: "dep-failed", dep: "require-all", rootCauses: ["require-all"] }),
    );
    await store.report(pass);
    store.interrupt();
    assert.deepEqual(report(), [
      "# Failures · ci.ts",
      "",
      "status: interrupted · started 1970-01-01T00:00:00.000Z",
      "✖︎ lint docs, require-all failed · built 0 · cached 0 · failed 2 · skipped 1",
      "",
      "A forced exit stopped the run while `build` ran.",
      "",
      "## ✖︎ lint docs · exit 1 · 0.0s · 2 lines",
      "",
      "- command: ``` awk '/``/ { print; bad = 1 } END { exit bad }' docs/a.md ``` (cwd `.`)",
      "- log: `.dag/logs/lint docs.log` (2 lines)",
      "- rerun: `npx --no dag run ci.ts --only 'lint docs'`",
      "",
      "````text",
      "```",
      "Run ``bun test`` first",
      "````",
      "",
      "## ✖︎ require-all · 0.0s",
      "",
      "- error: failed: lint",
      "- log: `.dag/logs/require-all.log` (0 lines)",
      "- dependencies that also failed: `lint docs`",
      "- skipped because of it: `deploy`",
      "- rerun: `npx --no dag run ci.ts --only require-all`",
      ...TAIL,
    ]);
  });

  test("a node that never started, and one whose program could not start", async () => {
    const keyed = nodeNamed("keyed");
    const spawn = nodeNamed("spawn");
    const pass = { title: "ci.ts", nodes: [keyed, spawn] };
    const { store, report } = reportRun(["spawn"]);
    store.begin(pass);
    store.onEvent({ type: "dispatch", node: "keyed", occurredAt: 0 });
    store.onEvent(
      settledAs(keyed, { status: "failed", error: { name: "Error", message: "ENOENT: src/a.ts" } }),
    );
    for (const event of started(spawn)) store.onEvent(event);
    store.onEvent(printed(spawn, "spawn spawn ENOENT"));
    const why =
      "could not start spawn. Check that it is on the command's PATH and that its cwd exists.";
    store.onEvent(
      failed(spawn, why, { argv: ["spawn"], cwd: ".", ended: "not-started", code: -1 }),
    );
    await store.close();
    assert.deepEqual(report(), [
      "# Failures · ci.ts",
      "",
      "status: finished · started 1970-01-01T00:00:00.000Z · wall 0.0s",
      "✖︎ keyed, spawn failed · built 0 · cached 0 · failed 2 · skipped 0",
      "",
      "## ✖︎ keyed · not started",
      "",
      "- error: ENOENT: src/a.ts",
      "- rerun: `npx --no dag run ci.ts --only keyed`",
      "",
      "## ✖︎ spawn · 0.0s · 1 line",
      "",
      "- command: `spawn` (cwd `.`)",
      `- error: ${why}`,
      "- log: `.dag/logs/spawn.log` (1 line)",
      "- rerun: `npx --no dag run ci.ts --only spawn`",
      "",
      "```text",
      "spawn spawn ENOENT",
      "```",
      ...TAIL,
    ]);
  });

  test("a cancel, then a forced exit while the post pass runs", async () => {
    const fast = nodeNamed("fast");
    const slow = nodeNamed("slow", ["fast"]);
    const release = nodeNamed("release", ["fast"]);
    const { store, report } = reportRun(["fast", "slow", "release"]);
    const pass = { title: "ci.ts", nodes: [fast, slow, release] };
    store.begin(pass);
    for (const event of started(fast)) store.onEvent(event);
    store.onEvent(built(fast));
    for (const event of started(slow)) store.onEvent(event);
    store.cancel();
    store.onEvent(
      settledAs(slow, { status: "cancelled", details: { actionKey: "k-slow", elapsed: 1 } }),
    );
    store.onEvent(settledAs(release, { status: "cancelled" }));
    await store.report(pass);
    const cancelled = report();
    store.begin({ title: "ci.ts · post", nodes: [release] });
    for (const event of started(release)) store.onEvent(event);
    store.interrupt();
    const counts = "built 1 · cached 0 · failed 0 · skipped 0 · cancelled 1";
    assert.deepEqual(
      { cancelled, interrupted: report() },
      {
        cancelled: [
          "# Failures · ci.ts",
          "",
          "status: cancelling · started 1970-01-01T00:00:00.000Z",
          "",
          "No failures so far.",
          ...TAIL,
        ],
        interrupted: [
          "# Failures · ci.ts",
          "",
          "status: interrupted · started 1970-01-01T00:00:00.000Z",
          `◼︎ cancelled, 1 node not run · ${counts}`,
          "",
          "A forced exit stopped the run while `release` ran.",
          "",
          "No failures.",
          ...TAIL,
        ],
      },
    );
  });

  test("a run of no workflow file is titled run, and its failure has no rerun bullet", async () => {
    const lint = nodeNamed("lint");
    const { store, report } = reportRun(["lint"], undefined, { workflowFile: undefined });
    store.begin({ title: "run", nodes: [lint] });
    for (const event of started(lint)) store.onEvent(event);
    store.onEvent(printed(lint, "src/a.ts: error\n"));
    store.onEvent(failed(lint, "lint exited 1", exited(["lint"], 1)));
    await store.close();
    assert.deepEqual(report(), [
      "# Failures · run",
      "",
      "status: finished · started 1970-01-01T00:00:00.000Z · wall 0.0s",
      "✖︎ lint failed · built 0 · cached 0 · failed 1 · skipped 0",
      "",
      "## ✖︎ lint · exit 1 · 0.0s · 1 line",
      "",
      "- command: `lint` (cwd `.`)",
      "- log: `.dag/logs/lint.log` (1 line)",
      "",
      "```text",
      "src/a.ts: error",
      "```",
      ...TAIL,
    ]);
  });

  test("a run that errors before any node runs", async () => {
    const { store, report } = reportRun([]);
    await store.close(new Error("bad config\n    at ci.ts:3"));
    assert.deepEqual(report(), [
      "# Failures · ci.ts",
      "",
      "status: errored",
      "✖︎ errored: bad config",
      "",
      "```text",
      "bad config",
      "    at ci.ts:3",
      "```",
      ...TAIL,
    ]);
  });

  test("a forced exit before the graph is built, and a report it cannot write: one warning, and no write after it", async () => {
    const { store, report } = reportRun([]);
    store.interrupt();
    const calls: string[] = [];
    const unwritable = reportRun([], {
      mkdirSync: (path) => void calls.push(`mkdir ${String(path)}`),
      writeFileSync: (path) => {
        calls.push(`write ${String(path)}`);
        throw new Error("EACCES: permission denied");
      },
      appendFileSync: (path) => void calls.push(`append ${String(path)}`),
    });
    const lint = nodeNamed("lint");
    unwritable.store.begin({ title: "ci.ts", nodes: [lint] });
    for (const event of started(lint)) unwritable.store.onEvent(event);
    unwritable.store.onEvent(failed(lint, "lint exited 1", exited(["lint"], 1)));
    await unwritable.store.close();
    assert.deepEqual(
      { report: report(), calls, annotations: unwritable.recorded.annotations },
      {
        report: [
          "# Failures · ci.ts",
          "",
          "status: interrupted",
          "",
          "A forced exit stopped the run.",
          "",
          "No failures.",
          ...TAIL,
        ],
        calls: ["mkdir .dag", "write .dag/failures.md"],
        annotations: [
          {
            level: "warning",
            title: "dag",
            message: "failures report off: EACCES: permission denied",
          },
        ],
      },
    );
  });
});
