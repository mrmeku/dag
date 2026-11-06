import type { ExecutionEvent, Node, NodeResult } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { memoryRuntime } from "../../memory/index.ts";
import { createRecordingHost } from "../../recording/index.ts";
import { createRunStore } from "../../run-store/index.ts";
import type { SyncFileSystem } from "../../wiring/index.ts";
import { createLogFiles } from "./index.ts";

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
const entry = { outputs: {}, contentHash: "h", outputHashes: {} };
const built = (node: Node) =>
  settledAs(node, {
    status: "succeeded",
    details: { actionKey: `k-${node.name}`, entry, actionRan: true, elapsed: 1 },
  });

/** The log files of a run on a fresh memory runtime, its store over the same files. */
function logFilesRun(files: Record<string, string> = {}, syncFs?: SyncFileSystem) {
  const runtime = memoryRuntime({ files });
  const recorded = createRecordingHost();
  const logFiles = createLogFiles(".dag/logs", syncFs ?? runtime.syncFs, recorded.host);
  const store = createRunStore({
    fs: runtime.fs,
    buildLogDir: "/build-logs",
    durationsFile: "/durations/ci.ts.json",
    listeners: [logFiles],
  });
  const filesNow = () =>
    Object.fromEntries(
      [...runtime.fs.files]
        .filter(([path]) => !path.startsWith("/build-logs/"))
        .map(([path, file]) => [path, String(file.data)]),
    );
  return { store, logFiles, recorded, filesNow };
}

describe("log files", () => {
  test("each node's log under the log dir whatever its name, emptied at its start; none for a node that never started", async () => {
    const { store, logFiles, filesNow } = logFilesRun({
      ".dag/logs/old.log": "a node outside this run\n",
      ".dag/logs/lint.log": "lint's last run\n",
    });
    const [up, restore, abs, colon, lint] = [
      nodeNamed("../up"),
      nodeNamed("restore:cache"),
      nodeNamed("/abs"),
      nodeNamed(":"),
      nodeNamed("lint"),
    ];
    const deploy = nodeNamed("deploy", ["lint"]);
    const pass = { title: "ci.ts", nodes: [up, restore, abs, colon, lint, deploy] };
    store.begin(pass);
    for (const node of [up, abs, colon]) {
      for (const event of started(node)) store.onEvent(event);
      store.onEvent(printed(node, "up\n\n"));
      store.onEvent(built(node));
    }
    for (const event of started(restore)) store.onEvent(event);
    store.onEvent(printed(restore, "Cache not found for input keys: k\n"));
    store.onEvent(built(restore));
    for (const event of started(lint)) store.onEvent(event);
    store.onEvent(printed(lint, "checking\n"));
    store.onEvent(printed(lint, "\x1b[31merror\x1b[0m"));
    store.onEvent(
      settledAs(lint, {
        status: "failed",
        error: { name: "Error", message: "lint exited 1" },
        details: { actionKey: "k-lint", elapsed: 1 },
      }),
    );
    store.onEvent(settledAs(deploy, { status: "dep-failed", dep: "lint", rootCauses: ["lint"] }));
    await store.report(pass);
    assert.deepEqual(
      {
        files: filesNow(),
        written: [up, deploy].map((node) => logFiles.writtenLogFile(node.name)),
      },
      {
        files: {
          ".dag/logs/old.log": "a node outside this run\n",
          ".dag/logs/lint.log": "checking\nerror\n",
          ".dag/logs/%2E%2E/up.log": "up\n\n",
          ".dag/logs/abs.log": "up\n\n",
          ".dag/logs/%3A.log": "up\n\n",
          ".dag/logs/restore/cache.log": "Cache not found for input keys: k\n",
        },
        written: [".dag/logs/%2E%2E/up.log", undefined],
      },
    );
  });

  test("a post step that printed before its cancel, then hit the cache in the post pass, has the cached log", async () => {
    const { store, filesNow } = logFilesRun({ "/build-logs/ks.log": "saved from the cache\n" });
    const save = nodeNamed("save");
    const post = { title: "ci.ts · post", nodes: [save] };
    store.begin({ title: "ci.ts", nodes: [save] });
    for (const event of started(save)) store.onEvent(event);
    store.onEvent(printed(save, "saving\n"));
    store.cancel();
    store.onEvent(settledAs(save, { status: "cancelled" }));
    store.begin(post);
    store.onEvent({ type: "dispatch", node: "save", occurredAt: 0 });
    store.onEvent(
      settledAs(save, {
        status: "succeeded",
        details: { actionKey: "ks", entry, actionRan: false },
      }),
    );
    await store.report(post);
    assert.deepEqual(filesNow(), { ".dag/logs/save.log": "saved from the cache\n" });
  });

  test("a forced exit ends the line a node was printing", () => {
    const { store, filesNow } = logFilesRun();
    const build = nodeNamed("build");
    store.begin({ title: "ci.ts", nodes: [build] });
    for (const event of started(build)) store.onEvent(event);
    store.onEvent(printed(build, "compiling\n\x1b[1m50%\x1b[22m"));
    store.interrupt();
    assert.deepEqual(filesNow(), { ".dag/logs/build.log": "compiling\n50%\n" });
  });

  test("the first write that fails warns once on the host, and the files stop there", async () => {
    const calls: string[] = [];
    let writes = 0;
    const failing: SyncFileSystem = {
      mkdirSync: (path) => void calls.push(`mkdir ${String(path)}`),
      writeFileSync: (path) => {
        calls.push(`write ${String(path)}`);
        if (++writes === 2) throw new Error("ENOSPC: no space left on device");
      },
      appendFileSync: (path) => {
        calls.push(`append ${String(path)}`);
        if (++writes === 2) throw new Error("ENOSPC: no space left on device");
      },
    };
    const { store, recorded } = logFilesRun({}, failing);
    const [a, b] = [nodeNamed("a"), nodeNamed("b")];
    const pass = { title: "ci.ts", nodes: [a, b] };
    store.begin(pass);
    for (const event of started(a)) store.onEvent(event);
    store.onEvent(printed(a, "one\n"));
    store.onEvent(printed(a, "two\n"));
    store.onEvent(built(a));
    for (const event of started(b)) store.onEvent(event);
    store.onEvent(printed(b, "three\n"));
    store.onEvent(built(b));
    await store.report(pass);
    store.interrupt();
    assert.deepEqual(
      { calls, annotations: recorded.annotations },
      {
        calls: ["mkdir .dag/logs", "write .dag/logs/a.log", "append .dag/logs/a.log"],
        annotations: [
          {
            level: "warning",
            title: "dag",
            message: "log files off: ENOSPC: no space left on device",
          },
        ],
      },
    );
  });
});
