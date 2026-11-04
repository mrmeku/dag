/**
 * The Node adapter of the cache's `FileSystem`. Published as the `@mrmeku/dagraph/fs/node` subpath,
 * never from the package index: it imports node:fs, and only filesystem/ may import an I/O module.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isMissingFileError, type FileSystem } from "../cache/index.ts";

/** Streams large files through the hasher instead of reading them whole. */
export function createNodeFileSystem(): FileSystem {
  return {
    readText: (path) => readFile(path, "utf8"),
    writeText: async (path, content) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
    hashFile: async (path) => {
      const hasher = createHash("sha256");
      for await (const chunk of createReadStream(path)) {
        if (!(chunk instanceof Uint8Array)) throw new Error(`${path}: a read gave no bytes`);
        hasher.update(chunk);
      }
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
