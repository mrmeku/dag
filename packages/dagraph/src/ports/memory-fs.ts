import type { DagFs } from "../cache.ts";
import { hashBytes } from "../content-addressing.ts";

export type MemoryDagFs = DagFs & { files: Map<string, string | Uint8Array> };

/**
 * In-memory DagFs for tests. `files` is exposed so a test can inspect or seed it directly. A
 * directory is the files under its path, so an empty one does not exist.
 */
export function createMemoryDagFs(initial?: Record<string, string | Uint8Array>): MemoryDagFs {
  const files = new Map<string, string | Uint8Array>(initial ? Object.entries(initial) : []);
  const get = (path: string) => {
    const data = files.get(path);
    if (data === undefined) throw new Error(`ENOENT: ${path}`);
    return data;
  };
  const under = (dir: string) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`));
  return {
    files,
    exists: async (path) => files.has(path),
    readText: async (path) => {
      const data = get(path);
      return typeof data === "string" ? data : new TextDecoder().decode(data);
    },
    writeText: async (path, content) => {
      files.set(path, content);
    },
    hashFile: async (path) => hashBytes(get(path)),
    ensureDir: async () => {},
    rename: async (from, to) => {
      if (files.has(from)) {
        files.set(to, get(from));
        files.delete(from);
        return;
      }
      if (under(from).length === 0) throw new Error(`ENOENT: ${from}`);
      if (under(to).length > 0) throw new Error(`ENOTEMPTY: ${to}`);
      for (const p of under(from)) {
        files.set(to + p.slice(from.length), get(p));
        files.delete(p);
      }
    },
    remove: async (path) => {
      for (const p of [...files.keys()])
        if (p === path || p.startsWith(`${path}/`)) files.delete(p);
    },
    readdir: async (dir) => {
      const parent = dir.replace(/\/$/, "");
      return [...new Set(under(parent).map((p) => p.slice(parent.length + 1).split("/")[0]!))];
    },
  };
}
