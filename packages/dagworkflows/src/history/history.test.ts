import { createMemoryFileSystem, errorMessage, type NodeResult } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { test } from "node:test";
import { lockOptions } from "../lock/index.ts";
import { clockAt, memoryRuntime } from "../memory/index.ts";
import {
  claimHistory,
  createRunHistory,
  owedPosts,
  readRunHistory,
  removeHistory,
  runHistoryLive,
  stoppedHistories,
  type RunHistoryFile,
} from "./index.ts";

const DIR = "/state/history";
const EMPTY: RunHistoryFile = { workflow: "/repo/ci.ts", started: [], results: {} };
const succeeded = (name: string): NodeResult => ({
  name,
  status: "succeeded",
  details: {
    actionKey: `key-${name}`,
    entry: { outputs: {}, contentHash: "h", outputHashes: {} },
    actionRan: true,
    elapsed: 1,
  },
});

test("a result in an older shape is dropped, and its main still owes its post; a post is owed when its main started and it has not succeeded", async () => {
  const path = `${DIR}/stopped.json`;
  // up:db's result as an earlier version of dag wrote it.
  const upInAnOlderShape = {
    name: "up:db",
    actionKey: "ku",
    status: "done",
    outputs: { id: "/cache/v1/ku/h/id" },
    contentHash: "h",
    outputHashes: { id: "h" },
    elapsed: 1,
  };
  const fs = createMemoryFileSystem({
    [path]: JSON.stringify({
      workflow: "",
      only: ["down:db", "down:mail", "down:queue"],
      started: ["up:db", "up:mail"],
      results: {
        "up:db": upInAnOlderShape,
        "up:mail": succeeded("up:mail"),
        "down:mail": succeeded("down:mail"),
      },
    }),
  });
  const read = await readRunHistory(fs, path);
  const posts = new Map([
    ["down:db", "up:db"],
    ["down:mail", "up:mail"],
    ["down:queue", "up:queue"],
  ]);
  assert.deepEqual(
    { read, owed: owedPosts(read, posts) },
    {
      read: {
        workflow: "",
        only: ["down:db", "down:mail", "down:queue"],
        started: ["up:db", "up:mail"],
        results: { "up:mail": succeeded("up:mail"), "down:mail": succeeded("down:mail") },
      },
      // up:queue never started; down:mail succeeded.
      owed: new Set(["down:db"]),
    },
  );
});

test("a file that is not a run's history is refused with its reason", async () => {
  const cut = '{\n  "workflow": "", "started": [], "results": {"up:db": {"status": "do';
  const files = {
    [`${DIR}/before-starts.json`]: JSON.stringify({ workflow: "", results: {} }),
    [`${DIR}/other.json`]: JSON.stringify({ workflow: "", only: "lint", started: [], results: {} }),
    [`${DIR}/cut.json`]: cut,
  };
  const fs = createMemoryFileSystem(files);
  const refusals = await Promise.all(
    Object.keys(files).map((path) => readRunHistory(fs, path).then(String, errorMessage)),
  );
  // The parser's own words differ between Node and Bun.
  let parserWords = "";
  try {
    JSON.parse(cut);
  } catch (e) {
    parserWords = errorMessage(e);
  }
  assert.deepEqual(refusals, [
    "it records no started nodes, as a history from before dag recorded them",
    "not a run's history: it lacks its workflow, started nodes or results",
    parserWords,
  ]);
});

test("a run killed mid-write leaves its last whole history, listed as stopped once its lock has gone 10 s without a refresh, the half write deleted; a live run's history is never listed", async () => {
  let now = 0;
  const { lockfile } = memoryRuntime({ clock: clockAt(() => now) });
  const memory = createMemoryFileSystem();
  const killed = Promise.withResolvers<void>();
  const fs = {
    ...memory,
    writeText: async (path: string, content: string) => {
      if (!content.includes('"up:db"')) return memory.writeText(path, content);
      await memory.writeText(path, content.slice(0, content.length / 2));
      killed.resolve();
      // Killed: the write never ends.
      await new Promise(() => {});
    },
  };
  const live = await createRunHistory(fs, lockfile, DIR, EMPTY);
  await live.begin();
  const killedRun = await createRunHistory(fs, lockfile, DIR, EMPTY);
  await killedRun.begin();
  void killedRun.onEvent({ type: "start", node: "up:db", occurredAt: 0 });
  await killed.promise;
  lockfile.abandon(killedRun.path);
  const stoppedAt = async (time: number) => {
    now = time;
    return stoppedHistories(fs, lockfile, DIR);
  };
  const atStale = await stoppedAt(10_000);
  const pastStale = await stoppedAt(10_001);
  const muchLater = await stoppedAt(1_000_000);
  assert.deepEqual(
    {
      atStale,
      pastStale,
      muchLater,
      files: [...memory.files.keys()].sort(),
      killedRun: await readRunHistory(fs, killedRun.path),
    },
    {
      atStale: [],
      pastStale: [killedRun.path],
      muchLater: [killedRun.path],
      files: [killedRun.path, live.path].sort(),
      killedRun: EMPTY,
    },
  );
});

test("a stopped history's lock, which a kill leaves on disk, goes with it whether it is removed or claimed", async () => {
  const { lockfile } = memoryRuntime();
  const removed = `${DIR}/removed.json`;
  const claimed = `${DIR}/claimed.json`;
  const fs = createMemoryFileSystem({
    [removed]: JSON.stringify(EMPTY),
    [claimed]: JSON.stringify(EMPTY),
  });
  for (const path of [removed, claimed]) await fs.ensureDir(lockOptions(path).lockfilePath);
  await removeHistory(fs, removed);
  const history = await claimHistory(fs, lockfile, claimed, EMPTY);
  assert.deepEqual(
    (await fs.readdir(DIR)).map((name) => `${DIR}/${name}`),
    [history?.path],
  );
});

test("a run whose lock is lost gets the lock's warning, goes on writing its history and closes it without rejecting", async () => {
  const { lockfile } = memoryRuntime();
  const fs = createMemoryFileSystem();
  const history = await createRunHistory(fs, lockfile, DIR, EMPTY);
  await history.begin();
  const warning = new Promise<Error>((resolve) => process.once("warning", resolve));
  lockfile.compromise(history.path);
  const { message } = await warning;
  await history.onEvent({ type: "start", node: "up:db", occurredAt: 0 });
  assert.deepEqual(
    {
      message,
      live: await runHistoryLive(lockfile, history.path),
      read: await readRunHistory(fs, history.path),
      closed: await history.close().then(() => "closed", errorMessage),
    },
    {
      message: `the lock on ${history.path} was lost: Lock is compromised`,
      live: false,
      read: { ...EMPTY, started: ["up:db"] },
      closed: "closed",
    },
  );
});
