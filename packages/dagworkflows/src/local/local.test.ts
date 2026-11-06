import type { ExecutionEvent, Node, NodeResult } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { memoryRuntime } from "../memory/index.ts";
import { createRunStore } from "../run-store/index.ts";
import { nullArtifactStore } from "../upload-artifact/index.ts";
import type { DisplayOptions, Runtime, SyncFileSystem, WriteStreams } from "../wiring/index.ts";
import { localPlatform } from "./index.ts";

/** git as a checkout with no `user.name` answers it: every other command prints nothing. */
const gitExec: Runtime["exec"] = {
  run: async (argv) => {
    const stdout = argv.join(" ") === "git symbolic-ref HEAD" ? "refs/heads/trunk\n" : "";
    return { ended: "exited", code: 0, stdout, stderr: "", output: stdout, ok: true };
  },
};

/** A stdout and stderr that record what is written to them, not a terminal. */
function recordingStreams() {
  const writes: string[] = [];
  const write = (chunk: string | Uint8Array) => writes.push(String(chunk)) > 0;
  const streams: WriteStreams = { stdout: { write, isTTY: false, columns: 80 }, stderr: { write } };
  return { streams, stdout: () => writes.join("").split("\n") };
}

/**
 * `localPlatform` for `command` on a memory runtime whose git is scripted and whose `$USER` is
 * `dev`, the display in the `failures` style so no process fact chooses it.
 */
function localRun(
  command: "run" | "post",
  display: Omit<DisplayOptions, "style" | "streams"> = {},
  syncFs?: SyncFileSystem,
) {
  const memory = memoryRuntime();
  const runtime: Runtime = {
    ...memory,
    exec: gitExec,
    env: { USER: "dev" },
    syncFs: syncFs ?? memory.syncFs,
  };
  const { streams, stdout } = recordingStreams();
  const platform = localPlatform(runtime, {
    display: { ...display, style: "failures", streams },
    paths: { cacheDir: ".dag/cache" },
    command,
    workflowFile: "ci flows.ts",
  });
  return { platform, fs: memory.fs, stdout };
}

const nodeNamed = (name: string): Node => ({ name, kind: name, deps: [] });
type Settled<R = NodeResult> = R extends unknown ? Omit<R, "name"> : never;
const settledAs = (node: Node, result: Settled): ExecutionEvent => ({
  type: "result",
  node: node.name,
  result: { name: node.name, ...result },
  occurredAt: 0,
});
const started = (node: Node): ExecutionEvent[] => [
  { type: "dispatch", node: node.name, occurredAt: 0 },
  { type: "start", node: node.name, occurredAt: 0 },
];
const failed = (node: Node, message: string): ExecutionEvent =>
  settledAs(node, {
    status: "failed",
    error: {
      name: "Error",
      message,
      cause: { argv: [node.name], cwd: ".", ended: "exited", code: 1 },
    },
    details: { actionKey: `k-${node.name}`, elapsed: 1 },
  });

/**
 * A run of the platform's listeners, as `processPorts` makes its store: `earlier` nodes settle,
 * then `lint` fails, then the summary.
 */
async function lintFails(platform: ReturnType<typeof localPlatform>, earlier: Node[] = []) {
  const listeners = await platform.listeners();
  assert.ok(listeners, "the local display");
  const store = createRunStore({ fs: memoryRuntime().fs, durationsFile: "d.json", listeners });
  const lint = nodeNamed("lint");
  const nodes = [...earlier, lint];
  const scope = nodes.length === 1 ? "1 node" : `${nodes.length} nodes`;
  const pass = {
    banner: { title: `ci flows.ts · ${scope}`, lines: [] },
    title: "ci flows.ts",
    nodes,
  };
  store.begin(pass);
  for (const node of earlier) {
    for (const event of started(node)) store.onEvent(event);
    // A stack trace with no command, which spends the output budget on its own.
    const trace = Array.from({ length: 80 }, (_, i) => `    at frame${i} ${"x".repeat(90)}`);
    store.onEvent(
      settledAs(node, {
        status: "failed",
        error: { name: "Error", message: [`${node.name} failed`, ...trace].join("\n") },
        details: { actionKey: `k-${node.name}`, elapsed: 1 },
      }),
    );
  }
  await store.report(pass);
  for (const event of started(lint)) store.onEvent(event);
  store.onEvent({ type: "output", node: "lint", chunk: "src/a.ts: error\n", occurredAt: 0 });
  store.onEvent(failed(lint, "lint exited 1"));
  await store.report(pass);
  await (await platform.host()).summary("## ci flows.ts\n");
  await store.close();
}

describe("the local platform", () => {
  test("one host however often asked, with git's context; no display for post; the worktree cache and no artifacts, neither with a notice", async () => {
    const { platform } = localRun("post");
    const [host, again] = [await platform.host(), await platform.host()];
    const artifacts = await platform.artifactStore();
    const cache = await platform.cacheStore();
    assert.deepEqual(
      {
        name: platform.name,
        sameHost: host === again,
        context: await host.context(),
        listeners: await platform.listeners(),
        artifacts,
        cacheNotice: "notice" in cache,
      },
      {
        name: "local",
        sameHost: true,
        context: {
          isCi: false,
          provider: "local",
          ref: "refs/heads/trunk",
          sha: "",
          eventName: "local",
          actor: "dev",
          runId: 0,
          repo: { owner: "", repo: "" },
          serverUrl: "",
        },
        listeners: undefined,
        artifacts: { store: nullArtifactStore },
        cacheNotice: false,
      },
    );
  });

  test("a run's log files, report and summary under .dag/ unless given, the banner pointing at the report", async () => {
    const files = async (display: Omit<DisplayOptions, "style" | "streams">) => {
      const { platform, fs, stdout } = localRun("run", display);
      await lintFails(platform);
      return { files: [...fs.files.keys()].sort(), stdout: stdout().slice(0, 8) };
    };
    const shown = (report: string, summary: string, logs: string) => [
      `ci flows.ts · 1 node · report ${report}`,
      "✖︎ lint  exit 1 · 0.0s · 1 line",
      "│ src/a.ts: error",
      `├ log    ${logs}/lint.log`,
      "├ cmd    lint   (cwd .)",
      "└ rerun  npx --no dag run 'ci flows.ts' --only lint",
      `summary: ${summary}`,
      "",
    ];
    assert.deepEqual(
      {
        defaults: await files({}),
        given: await files({
          logDir: "out/logs",
          failuresReportFile: "out/f.md",
          summaryFile: "out/s.md",
        }),
      },
      {
        defaults: {
          files: [".dag/failures.md", ".dag/logs/lint.log", ".dag/summary.md"],
          stdout: shown(".dag/failures.md", ".dag/summary.md", ".dag/logs"),
        },
        given: {
          files: ["out/f.md", "out/logs/lint.log", "out/s.md"],
          stdout: shown("out/f.md", "out/s.md", "out/logs"),
        },
      },
    );
  });

  test("a log write that fails once the output budget is spent: its warning counts as a line left out", async () => {
    const leftOut = async (syncFs?: SyncFileSystem) => {
      const { platform, stdout } = localRun("run", {}, syncFs);
      await lintFails(platform, [nodeNamed("build")]);
      const lines = stdout();
      return {
        warningShown: lines.some((line) => line.includes("log files off")),
        leftOut: lines.filter((line) => line.includes("left out")),
      };
    };
    const memory = memoryRuntime();
    // Its log file made at its start, so only the warning tells the two runs apart.
    const failingLintOutput: SyncFileSystem = {
      ...memory.syncFs,
      appendFileSync: (path, data) => {
        if (String(path).endsWith("lint.log")) throw new Error("ENOSPC: no space left on device");
        memory.syncFs.appendFileSync(path, data);
      },
    };
    assert.deepEqual(
      { writable: await leftOut(), failing: await leftOut(failingLintOutput) },
      {
        writable: {
          warningShown: false,
          leftOut: ["24 lines left out · all of it in .dag/failures.md"],
        },
        failing: {
          warningShown: false,
          leftOut: ["25 lines left out · all of it in .dag/failures.md"],
        },
      },
    );
  });
});
