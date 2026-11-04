/**
 * The Bun adapter of the cache's `FileSystem`. Published as the `@mrmeku/dagraph/fs` subpath, never
 * from the package index: it imports node:fs, and only filesystem/ may import an I/O module.
 */
import { chmod, lstat, mkdir, open, readdir, rename, rm, utimes } from "node:fs/promises";
import { resolve } from "node:path";
import { isMissingFileError, type FileSystem } from "../cache/index.ts";

/** Streams large files through the native hasher instead of reading them whole. */
export function createBunFileSystem(): FileSystem {
  return {
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
    lstat,
    chmod,
    fsync: async (path) => {
      const file = await open(path, "r");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    },
    utimes,
    readdir: (dir) =>
      readdir(dir).catch((e: unknown) => {
        if (isMissingFileError(e)) return [];
        throw e;
      }),
    resolve,
  };
}
