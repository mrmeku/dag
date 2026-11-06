import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createMemoryWorkflowFileSystem } from "./index.ts";

const codeOf = (write: () => void) => {
  try {
    write();
    return undefined;
  } catch (e) {
    return e instanceof Error && "code" in e ? e.code : e;
  }
};

test("synchronous writes, by any path and data node:fs takes, a file URL's escapes decoded, are read back through the async file system, and as node:fs's need their directory made", async () => {
  const { fs, syncFs } = createMemoryWorkflowFileSystem({ "/seeded.txt": "seed" });
  syncFs.mkdirSync("/logs", { recursive: true });
  syncFs.writeFileSync("/logs/a.log", "one\n");
  syncFs.appendFileSync(Buffer.from("/logs/a.log"), new TextEncoder().encode("two\n"));
  syncFs.writeFileSync(pathToFileURL("/logs/b c.log"), Buffer.from("bee"));
  assert.deepEqual(
    {
      a: await fs.readText("/logs/a.log"),
      b: await fs.readText("/logs/b c.log"),
      seeded: await fs.readText("/seeded.txt"),
      unmade: codeOf(() => syncFs.writeFileSync("/unmade/c.log", "c")),
    },
    { a: "one\ntwo\n", b: "bee", seeded: "seed", unmade: "ENOENT" },
  );
});

test("exists holds for a file and a directory, and an empty directory mkdirSync makes is seen by exists and readdir", async () => {
  const { fs, syncFs } = createMemoryWorkflowFileSystem({ "/src/a.ts": "a" });
  syncFs.mkdirSync("/out/empty", { recursive: true });
  assert.deepEqual(
    {
      file: await fs.exists("/src/a.ts"),
      directory: await fs.exists("/src"),
      nothing: await fs.exists("/src/b.ts"),
      empty: await fs.exists("/out/empty"),
      out: await fs.readdir("/out"),
      inEmpty: await fs.readdir("/out/empty"),
    },
    { file: true, directory: true, nothing: false, empty: true, out: ["empty"], inEmpty: [] },
  );
});
