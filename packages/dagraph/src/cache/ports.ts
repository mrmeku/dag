import type { HashFile } from "../graph/index.ts";

/**
 * What `lstat` tells of a path. Named as a type alone: only filesystem/ imports an I/O module by
 * value.
 */
export type Stats = Pick<import("node:fs").Stats, "isFile" | "mode" | "size" | "mtimeMs">;

/**
 * The filesystem the cache reads and writes. Its adapters are in `filesystem/`. The cache calls
 * its members detached, as `fs.hashFile`, so none may read `this`.
 */
export interface FileSystem {
  readText: (path: string) => Promise<string>;
  writeText: (path: string, content: string) => Promise<void>;
  hashFile: HashFile;
  ensureDir: (path: string) => Promise<void>;
  /** POSIX `rename`: replaces a file at `to` atomically; fails when `to` is a non-empty directory. */
  rename: (from: string, to: string) => Promise<void>;
  /** Removes a file, or a directory and everything in it; nothing when the path does not exist. */
  remove: (path: string) => Promise<void>;
  /** POSIX `lstat`; rejects with code `ENOENT` when nothing is at `path`, as node:fs does. */
  lstat: (path: string) => Promise<Stats>;
  /** POSIX `chmod`: sets a file's permission bits. */
  chmod: (path: string, mode: number) => Promise<void>;
  /** POSIX `fsync`: flushes a file's data to disk. */
  fsync: (path: string) => Promise<void>;
  /** POSIX `utimes`: sets the access and modification times of a file or a directory. */
  utimes: (path: string, atime: Date, mtime: Date) => Promise<void>;
  /** The names of the entries in a directory; none when the directory does not exist. */
  readdir: (dir: string) => Promise<string[]>;
  /** The absolute form of `path`, as an action sees it. */
  resolve: (path: string) => string;
}

/** Whether a read failed for want of a file, as `node:fs` and `FileSystem.lstat` reject. */
export const isMissingFileError = (e: unknown) =>
  e instanceof Error && "code" in e && e.code === "ENOENT";
