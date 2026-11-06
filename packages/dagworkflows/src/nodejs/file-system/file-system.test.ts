import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createNodeWorkflowFileSystem, syncFs } from "./index.ts";

test("exists holds for a file and a directory, not for nothing; the synchronous writes land on disk when they return", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-fs-"));
  try {
    writeFileSync(join(dir, "a.txt"), "a");
    mkdirSync(join(dir, "sub"));
    const fs = createNodeWorkflowFileSystem();
    syncFs.mkdirSync(join(dir, "logs"), { recursive: true });
    syncFs.writeFileSync(join(dir, "logs", "n.log"), "one\n");
    syncFs.appendFileSync(join(dir, "logs", "n.log"), "two\n");
    assert.deepEqual(
      {
        file: await fs.exists(join(dir, "a.txt")),
        directory: await fs.exists(join(dir, "sub")),
        nothing: await fs.exists(join(dir, "missing")),
        log: readFileSync(join(dir, "logs", "n.log"), "utf8"),
      },
      { file: true, directory: true, nothing: false, log: "one\ntwo\n" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
