/**
 * Node-backed DagFs. Published as the `@mrmeku/dagraph/fs/node` subpath, never from the
 * package index: it imports node:fs, and the index is bundled into Temporal's V8 workflow
 * sandbox, which admits no I/O modules (see sandbox-safe.test.ts).
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { DagFs } from "../cache.ts";

/** Streams large files through the hasher instead of reading them whole. */
export function createNodeDagFs(): DagFs {
  return {
    exists: (path) =>
      access(path).then(
        () => true,
        () => false,
      ),
    readText: (path) => readFile(path, "utf8"),
    writeText: async (path, content) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    hashFile: async (path) => {
      const hasher = createHash("sha256");
      for await (const chunk of createReadStream(path)) hasher.update(chunk as Uint8Array);
      return hasher.digest("hex");
    },
    ensureDir: async (path) => {
      await mkdir(path, { recursive: true });
    },
  };
}
