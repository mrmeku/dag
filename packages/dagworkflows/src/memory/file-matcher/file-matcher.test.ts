import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createMemoryFileMatcher } from "./index.ts";

test("match gives each held pattern's files sorted and deduplicated, a pattern it lacks none; hash digests them, or is empty for none", async () => {
  const matcher = createMemoryFileMatcher({
    "src/**": ["src/b.ts", "src/a.ts"],
    "*.json": ["package.json", "src/a.ts"],
  });
  assert.deepEqual(
    {
      match: await matcher.match(["src/**", "*.json", "!**/node_modules/**", "docs/**"]),
      hash: await matcher.hash(["src/**"]),
      unmatchedHash: await matcher.hash(["docs/**"]),
    },
    {
      match: ["package.json", "src/a.ts", "src/b.ts"],
      hash: createHash("sha256").update("src/a.ts\nsrc/b.ts").digest("hex"),
      unmatchedHash: "",
    },
  );
});
