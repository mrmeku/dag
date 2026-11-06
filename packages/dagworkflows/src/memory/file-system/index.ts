import { createMemoryFileSystem, type MemoryFileSystem } from "@mrmeku/dagraph";
import { fileURLToPath } from "node:url";
import type { SyncFileSystem } from "../../wiring/index.ts";
import type { WorkflowFileSystem } from "../../workflow/index.ts";

/** A path as `node:fs` takes one: a string, a `Buffer` or a file URL, never a file descriptor. */
const pathOf = (path: Parameters<SyncFileSystem["writeFileSync"]>[0]): string => {
  if (typeof path === "number") throw new Error("a file descriptor is not a path here");
  return path instanceof URL ? fileURLToPath(path) : String(path);
};

const dataOf = (data: string | NodeJS.ArrayBufferView): string | Uint8Array =>
  typeof data === "string"
    ? data
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();

/**
 * dagraph's memory file system, seeded with `files`, with `exists` for a file or a directory, and
 * synchronous writes over the same files, which, as `node:fs`'s, need the file's directory made.
 */
export function createMemoryWorkflowFileSystem(files: Record<string, string> = {}): {
  fs: MemoryFileSystem & WorkflowFileSystem;
  syncFs: SyncFileSystem;
} {
  const memory = createMemoryFileSystem(files);
  const fs = {
    ...memory,
    exists: (path: string) =>
      memory.lstat(path).then(
        () => true,
        () => false,
      ),
  };
  const syncFs: SyncFileSystem = {
    mkdirSync: (path) => {
      memory.ensureDirSync(pathOf(path));
      return undefined;
    },
    writeFileSync: (path, data) => memory.writeFileSync(pathOf(path), dataOf(data)),
    appendFileSync: (path, data) => memory.appendFileSync(pathOf(path), dataOf(data)),
  };
  return { fs, syncFs };
}
