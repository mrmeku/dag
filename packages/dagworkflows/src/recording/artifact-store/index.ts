import type { ArtifactStore } from "../../upload-artifact/index.ts";

export interface MemoryArtifactStore extends ArtifactStore {
  /** Uploaded artifacts by name, in order, each with the files it holds and the root they were relative to. */
  uploads: Map<string, { files: string[]; rootDirectory: string }>;
}

/**
 * An in-memory artifact store for tests, with the service's rules: a name uploads once per run,
 * so a second upload under the same name is refused unless it overwrites. It records names and
 * paths and reads no files.
 */
export function createMemoryArtifactStore(): MemoryArtifactStore {
  const uploads = new Map<string, { files: string[]; rootDirectory: string }>();
  let nextId = 0;
  return {
    uploads,
    upload: async (name, files, rootDirectory, { overwrite }) => {
      if (overwrite) uploads.delete(name);
      if (uploads.has(name)) throw new Error(`an artifact with this name already exists: ${name}`);
      uploads.set(name, { files, rootDirectory });
      return { id: ++nextId, size: files.length };
    },
  };
}
