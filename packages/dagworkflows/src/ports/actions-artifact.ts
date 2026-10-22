import type { ActionsArtifact, Ports } from "../ports.ts";

/** No artifact service: every upload is a no-op with no id, every delete finds nothing. The local default. */
export const nullActionsArtifact: ActionsArtifact = {
  uploadArtifact: async () => ({}),
  deleteArtifact: async () => {
    throw notFound();
  },
};

/** `@actions/artifact` reaches the service with the runtime token and results URL the runner hands a JavaScript action. */
export function artifactServiceAvailable(env: Ports["env"]): boolean {
  return Boolean(env["ACTIONS_RUNTIME_TOKEN"] && env["ACTIONS_RESULTS_URL"]);
}

function notFound(): Error {
  const e = new Error("Artifact not found");
  e.name = "ArtifactNotFoundError";
  return e;
}

export interface MemoryActionsArtifact extends ActionsArtifact {
  /** Uploaded artifacts by name, in order, each with the files it holds and the root they were relative to. */
  uploads: Map<string, { files: string[]; rootDirectory: string }>;
}

/**
 * An in-memory artifact service for tests, with the service's rules: a name uploads once per
 * run, so a second upload under the same name is refused until the first is deleted. It
 * records names and paths and reads no files.
 */
export function createMemoryActionsArtifact(): MemoryActionsArtifact {
  const uploads = new Map<string, { files: string[]; rootDirectory: string }>();
  let nextId = 0;
  return {
    uploads,
    uploadArtifact: async (name, files, rootDirectory) => {
      if (uploads.has(name)) throw new Error(`an artifact with this name already exists: ${name}`);
      uploads.set(name, { files, rootDirectory });
      return { id: ++nextId, size: files.length };
    },
    deleteArtifact: async (name) => {
      if (!uploads.delete(name)) throw notFound();
      return { id: nextId };
    },
  };
}
