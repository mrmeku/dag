import type { DagFs } from "../cache.ts";
import { hashBytes } from "../content-addressing.ts";

/** A file of the memory filesystem. Two paths that hold one object are hard links to one file. */
export interface MemoryFile {
  data: string | Uint8Array;
  mode: number;
  mtimeMs: number;
}

export type MemoryDagFs = DagFs & {
  files: Map<string, MemoryFile>;
  writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
};

/**
 * In-memory DagFs for tests. `files` is exposed so a test can inspect or seed it directly. A
 * directory is the files under its path, so an empty one does not exist. A path is its own
 * absolute form: `resolve` returns it as given. A write to a read-only file fails with `EACCES`,
 * and each write gives its file an mtime a millisecond later than any before. A directory's mtime
 * is the one `utimes` last gave it, or else 0.
 */
export function createMemoryDagFs(initial: Record<string, string | Uint8Array> = {}): MemoryDagFs {
  let lastMtimeMs = 0;
  const newFile = (data: string | Uint8Array): MemoryFile => ({
    data,
    mode: 0o644,
    mtimeMs: ++lastMtimeMs,
  });
  const files = new Map(Object.entries(initial).map(([path, data]) => [path, newFile(data)]));
  const directoryMtimes = new Map<string, number>();
  const failure = (code: string, path: string) =>
    Object.assign(new Error(`${code}: ${path}`), { code });
  const get = (path: string) => {
    const file = files.get(path);
    if (file === undefined) throw failure("ENOENT", path);
    return file;
  };
  const under = (dir: string) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`));
  const isAtOrUnder = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);
  const writeFile = async (path: string, data: string | Uint8Array) => {
    const file = files.get(path);
    if (file === undefined) files.set(path, newFile(data));
    else if ((file.mode & 0o200) === 0) throw failure("EACCES", path);
    else Object.assign(file, { data, mtimeMs: ++lastMtimeMs });
  };
  return {
    files,
    writeFile,
    exists: async (path) => files.has(path),
    readText: async (path) => {
      const { data } = get(path);
      return typeof data === "string" ? data : new TextDecoder().decode(data);
    },
    writeText: writeFile,
    hashFile: async (path) => hashBytes(get(path).data),
    ensureDir: async () => {},
    rename: async (from, to) => {
      if (files.has(from)) {
        files.set(to, get(from));
        files.delete(from);
        return;
      }
      if (under(from).length === 0) throw failure("ENOENT", from);
      if (under(to).length > 0) throw new Error(`ENOTEMPTY: ${to}`);
      for (const p of under(from)) {
        files.set(to + p.slice(from.length), get(p));
        files.delete(p);
      }
      for (const [p, mtimeMs] of [...directoryMtimes])
        if (isAtOrUnder(p, from)) {
          directoryMtimes.delete(p);
          directoryMtimes.set(to + p.slice(from.length), mtimeMs);
        }
    },
    remove: async (path) => {
      for (const map of [files, directoryMtimes])
        for (const p of [...map.keys()]) if (isAtOrUnder(p, path)) map.delete(p);
    },
    lstat: async (path) => {
      const file = files.get(path);
      if (file !== undefined) {
        const { data, mode, mtimeMs } = file;
        const size = (typeof data === "string" ? new TextEncoder().encode(data) : data).length;
        return { isFile: () => true, mode, size, mtimeMs };
      }
      if (under(path).length === 0) throw failure("ENOENT", path);
      const mtimeMs = directoryMtimes.get(path) ?? 0;
      return { isFile: () => false, mode: 0o755, size: 0, mtimeMs };
    },
    chmod: async (path, mode) => {
      get(path).mode = mode;
    },
    fsync: async (path) => void get(path),
    utimes: async (path, _atime, mtime) => {
      const file = files.get(path);
      if (file !== undefined) file.mtimeMs = mtime.getTime();
      else if (under(path).length > 0) directoryMtimes.set(path, mtime.getTime());
      else throw failure("ENOENT", path);
    },
    readdir: async (dir) => {
      const parent = dir.replace(/\/$/, "");
      return [
        ...new Set(under(parent).map((p) => p.slice(parent.length + 1).replace(/\/.*/s, ""))),
      ];
    },
    resolve: (path) => path,
  };
}
