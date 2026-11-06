import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryArtifactStore } from "./index.ts";

test("a second upload of one name is refused, and accepted when it overwrites", async () => {
  const store = createMemoryArtifactStore();
  const first = await store.upload("logs", ["a.log", "b.log"], "/w", {});
  const refused = await store.upload("logs", ["c.log"], "/w", {}).then(
    () => "accepted",
    (e: unknown) => (e instanceof Error ? e.message : e),
  );
  const overwritten = await store.upload("logs", ["c.log"], "/x", { overwrite: true });
  assert.deepEqual(
    { first, refused, overwritten, uploads: [...store.uploads] },
    {
      first: { id: 1, size: 2 },
      refused: "an artifact with this name already exists: logs",
      overwritten: { id: 2, size: 1 },
      uploads: [["logs", { files: ["c.log"], rootDirectory: "/x" }]],
    },
  );
});
