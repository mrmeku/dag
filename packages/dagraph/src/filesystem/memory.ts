import { hashBytes, type FileSystem } from "../cache/index.ts";

/** A file of the memory filesystem. Two paths that hold one object are hard links to one file. */
export interface MemoryFile {
  data: string | Uint8Array;
  mode: number;
  mtimeMs: number;
}

/** A directory of the memory filesystem. */
interface MemoryDirectory {
  mode: number;
  mtimeMs: number;
}

export type MemoryFileSystem = FileSystem & {
  files: Map<string, MemoryFile>;
  writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
};

/**
 * The in-memory double of the cache's `FileSystem`, for tests. It does on a directory what the
 * disk adapters do, failing with their codes: a write makes its file's directories, `ensureDir`
 * makes an empty one, and adding, removing or renaming an entry of a directory changes its mtime.
 * `files` is exposed so a test can inspect or seed it directly; a file seeded there makes the
 * directories above it exist. A path is its own absolute form: `resolve` returns it as given, and
 * the root always exists. A write to a read-only file fails with `EACCES`. Each write, and each
 * change to a directory, gives it an mtime a millisecond later than any before.
 */
export function createMemoryFileSystem(
  initial: Record<string, string | Uint8Array> = {},
): MemoryFileSystem {
  let lastMtimeMs = 0;
  const nextMtimeMs = () => ++lastMtimeMs;
  const files = new Map<string, MemoryFile>();
  const directories = new Map<string, MemoryDirectory>();
  const failure = (code: string, path: string) =>
    Object.assign(new Error(`${code}: ${path}`), { code });
  const trimmed = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
  const parentOf = (path: string) => {
    const slash = path.lastIndexOf("/");
    return slash <= 0 ? undefined : path.slice(0, slash);
  };
  const isAtOrUnder = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

  const move = <Entry>(map: Map<string, Entry>, from: string, to: string) => {
    for (const [p, entry] of [...map])
      if (isAtOrUnder(p, from)) {
        map.delete(p);
        map.set(to + p.slice(from.length), entry);
      }
  };

  const directoryAt = (path: string): MemoryDirectory | undefined => {
    const recorded = directories.get(path);
    if (recorded || ![...files.keys()].some((p) => p.startsWith(`${path}/`))) return recorded;
    const seeded = { mode: 0o755, mtimeMs: nextMtimeMs() };
    directories.set(path, seeded);
    return seeded;
  };
  /** Whether `path` may hold a new entry: it is the root, or a directory. */
  const holdsEntries = (path: string | undefined) =>
    path === undefined || directoryAt(path) !== undefined;
  const entryChanged = (dir: string | undefined) => {
    const directory = dir === undefined ? undefined : directoryAt(dir);
    if (directory) directory.mtimeMs = nextMtimeMs();
  };
  const makeDirectories = (path: string | undefined) => {
    if (path === undefined || directoryAt(path)) return;
    if (files.has(path)) throw failure("ENOTDIR", path);
    const parent = parentOf(path);
    makeDirectories(parent);
    directories.set(path, { mode: 0o755, mtimeMs: nextMtimeMs() });
    entryChanged(parent);
  };
  /** Nothing is at `path`: `ENOTDIR` when a file stands where a directory above it would. */
  const missing = (path: string) => {
    let above = parentOf(path);
    while (above !== undefined && !files.has(above)) above = parentOf(above);
    return failure(above === undefined ? "ENOENT" : "ENOTDIR", path);
  };
  const fileAt = (path: string) => {
    const file = files.get(path);
    if (file !== undefined) return file;
    throw directoryAt(path) ? failure("EISDIR", path) : missing(path);
  };
  const entryAt = (path: string) => {
    const entry = files.get(path) ?? directoryAt(trimmed(path));
    if (entry === undefined) throw missing(path);
    return entry;
  };
  const write = (path: string, data: string | Uint8Array) => {
    const file = files.get(path);
    if (file !== undefined) {
      if ((file.mode & 0o200) === 0) throw failure("EACCES", path);
      Object.assign(file, { data, mtimeMs: nextMtimeMs() });
      return;
    }
    if (directoryAt(path)) throw failure("EISDIR", path);
    const parent = parentOf(path);
    makeDirectories(parent);
    files.set(path, { data, mode: 0o644, mtimeMs: nextMtimeMs() });
    entryChanged(parent);
  };
  for (const [path, data] of Object.entries(initial)) write(path, data);
  const writeFile = async (path: string, data: string | Uint8Array) => write(path, data);

  return {
    files,
    writeFile,
    readText: async (path) => {
      const { data } = fileAt(path);
      return typeof data === "string" ? data : new TextDecoder().decode(data);
    },
    writeText: writeFile,
    hashFile: async (path) => hashBytes(fileAt(path).data),
    ensureDir: async (path) => {
      if (files.has(path)) throw failure("EEXIST", path);
      makeDirectories(trimmed(path));
    },
    rename: async (from, to) => {
      const file = files.get(from);
      const directory = file ? undefined : directoryAt(from);
      if (!file && !directory) throw failure("ENOENT", from);
      if (!holdsEntries(parentOf(to))) throw failure("ENOENT", to);
      if (from === to) return;
      if (file) {
        if (directoryAt(to)) throw failure("EISDIR", to);
        files.set(to, file);
        files.delete(from);
      } else {
        if (files.has(to)) throw failure("ENOTDIR", to);
        if (to.startsWith(`${from}/`)) throw failure("EINVAL", to);
        const target = directoryAt(to);
        if (target) {
          const occupied = [...files.keys(), ...directories.keys()].some((p) =>
            p.startsWith(`${to}/`),
          );
          if (occupied) throw failure("ENOTEMPTY", to);
          directories.delete(to);
        }
        move(files, from, to);
        move(directories, from, to);
      }
      entryChanged(parentOf(from));
      entryChanged(parentOf(to));
    },
    remove: async (path) => {
      const target = trimmed(path);
      let removed = false;
      for (const map of [files, directories] as const)
        for (const p of [...map.keys()])
          if (isAtOrUnder(p, target)) {
            map.delete(p);
            removed = true;
          }
      if (removed) entryChanged(parentOf(target));
    },
    lstat: async (path) => {
      const file = files.get(path);
      if (file !== undefined) {
        const { data, mode, mtimeMs } = file;
        const size = (typeof data === "string" ? new TextEncoder().encode(data) : data).length;
        return { isFile: () => true, mode, size, mtimeMs };
      }
      const { mode, mtimeMs } = entryAt(path);
      return { isFile: () => false, mode, size: 0, mtimeMs };
    },
    chmod: async (path, mode) => {
      entryAt(path).mode = mode;
    },
    fsync: async (path) => void entryAt(path),
    utimes: async (path, _atime, mtime) => {
      entryAt(path).mtimeMs = mtime.getTime();
    },
    readdir: async (path) => {
      if (files.has(path)) throw failure("ENOTDIR", path);
      const dir = trimmed(path);
      if (!directoryAt(dir)) return [];
      const under = [...files.keys(), ...directories.keys()].filter((p) => p.startsWith(`${dir}/`));
      return [...new Set(under.map((p) => p.slice(dir.length + 1).replace(/\/.*/s, "")))];
    },
    resolve: (path) => path,
  };
}
