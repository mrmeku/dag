import type { DagFs } from "../cache.ts";
import { hashBytes } from "../content-addressing.ts";

export type MemoryDagFs = DagFs & { files: Map<string, string | Uint8Array> };

/** In-memory DagFs for tests. `files` is exposed so a test can inspect or seed it directly. */
export function createMemoryDagFs(initial?: Record<string, string | Uint8Array>): MemoryDagFs {
  const files = new Map<string, string | Uint8Array>(initial ? Object.entries(initial) : []);
  const get = (path: string) => {
    const data = files.get(path);
    if (data === undefined) throw new Error(`ENOENT: ${path}`);
    return data;
  };
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
  };
}
