/**
 * Bun-backed DagFs. Published as the `@mrmeku/dagraph/fs` subpath, never from the package
 * index: it imports node:fs, and the index is bundled into Temporal's V8 workflow sandbox,
 * which admits no I/O modules (lint refuses them elsewhere, eslint.config.ts).
 */
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { DagFs } from "../cache.ts";

/** Streams large files through the native hasher instead of reading them whole. */
export function createBunDagFs(): DagFs {
  return {
    exists: (path) => Bun.file(path).exists(),
    readText: (path) => Bun.file(path).text(),
    writeText: async (path, content) => {
      await Bun.write(path, content);
    },
    hashFile: async (path) => {
      const hasher = new Bun.CryptoHasher("sha256");
      for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
      return hasher.digest("hex");
    },
    ensureDir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    rename,
    remove: (path) => rm(path, { recursive: true, force: true }),
    readdir: (dir) =>
      readdir(dir).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return [];
        throw e;
      }),
    resolve,
  };
}
