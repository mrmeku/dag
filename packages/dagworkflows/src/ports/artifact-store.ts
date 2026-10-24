import type { ArtifactClient } from "@actions/artifact";
import type { ArtifactStore, Ports } from "../ports.ts";

/**
 * The GitHub artifact store: an `@actions/artifact` client as an ArtifactStore. An `overwrite`
 * upload deletes the artifact of its name first, if the run has one.
 */
export function createActionsArtifactStore(
  client: Pick<ArtifactClient, "uploadArtifact" | "deleteArtifact">,
): ArtifactStore {
  return {
    upload: async (name, files, rootDirectory, { overwrite, retentionDays, compressionLevel }) => {
      if (overwrite)
        await client.deleteArtifact(name).catch((e: unknown) => {
          if (!(e instanceof Error && e.name === "ArtifactNotFoundError")) throw e;
        });
      const { id, size } = await client.uploadArtifact(name, files, rootDirectory, {
        ...(retentionDays !== undefined && { retentionDays }),
        ...(compressionLevel !== undefined && { compressionLevel }),
      });
      return id === undefined ? undefined : { id, size: size ?? 0 };
    },
  };
}

/** No artifact store: every upload is a no-op. The local default. */
export const nullArtifactStore: ArtifactStore = { upload: async () => undefined };

/** `@actions/artifact` reaches the service with the runtime token and results URL the runner hands a JavaScript action. */
export function artifactServiceAvailable(env: Ports["env"]): boolean {
  return Boolean(env["ACTIONS_RUNTIME_TOKEN"] && env["ACTIONS_RESULTS_URL"]);
}

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
