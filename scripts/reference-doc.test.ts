import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { REFERENCE_PATH, referenceDoc } from "./reference-doc.ts";

test("docs/reference.md matches the CLI, action.yml and config.ts; `bun run docs` rewrites it", async () => {
  const current = readFileSync(REFERENCE_PATH, "utf8");
  assert.equal(current, await referenceDoc(current));
});
