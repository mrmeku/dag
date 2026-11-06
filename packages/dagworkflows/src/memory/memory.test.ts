import assert from "node:assert/strict";
import { test } from "node:test";
import { clockAt, memoryRuntime } from "./index.ts";

test("each runtime is fresh, seeded with its files and matches, its locks on its clock, and never cancels", async () => {
  let now = 0;
  const runtime = memoryRuntime({
    clock: clockAt(() => now),
    files: { "/a.txt": "a" },
    matches: { "*.txt": ["a.txt"] },
  });
  const other = memoryRuntime();
  await runtime.fs.writeText("/b.txt", "b");
  await runtime.lockfile.lock("/run.json");
  runtime.lockfile.abandon("/run.json");
  now = 10_001;
  assert.deepEqual(
    {
      read: await runtime.fs.readText("/a.txt"),
      otherHolds: await other.fs.exists("/b.txt"),
      otherHeld: [...other.lockfile.held],
      matched: await runtime.fileMatcher.match(["*.txt"]),
      lockStale: !(await runtime.lockfile.check("/run.json", {})),
      env: runtime.env,
      cancelled: runtime.abortOnSignals().aborted,
    },
    {
      read: "a",
      otherHolds: false,
      otherHeld: [],
      matched: ["a.txt"],
      lockStale: true,
      env: {},
      cancelled: false,
    },
  );
});
