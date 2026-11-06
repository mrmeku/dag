import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryCacheStore } from "./index.ts";

test("a restore takes the exact cache key, else the newest prefix match of the key then each restore key; a held cache key is not saved again", async () => {
  const store = createMemoryCacheStore(["deps-a"]);
  const saved = [
    await store.save(["node_modules"], "deps-b"),
    await store.save(["other"], "deps-a"),
    await store.save(["x"], "deps-b-partial-1"),
    await store.save(["y"], "deps-a-partial-2"),
  ];
  assert.deepEqual(
    {
      saved,
      exact: await store.restore([], "deps-a", []),
      newestByKey: await store.restore([], "deps-", []),
      byRestoreKey: await store.restore([], "lock-1", ["lock-", "deps-b"]),
      miss: await store.restore([], "lock-1", ["lock-"]),
      savedCaches: [...store.savedCaches],
    },
    {
      saved: [true, false, true, true],
      exact: "deps-a",
      newestByKey: "deps-a-partial-2",
      byRestoreKey: "deps-b-partial-1",
      miss: undefined,
      savedCaches: [
        ["deps-a", []],
        ["deps-b", ["node_modules"]],
        ["deps-b-partial-1", ["x"]],
        ["deps-a-partial-2", ["y"]],
      ],
    },
  );
});
