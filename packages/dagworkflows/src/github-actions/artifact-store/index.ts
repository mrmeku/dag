import type { ArtifactClient } from "@actions/artifact";
import type { ArtifactStore } from "../../upload-artifact/index.ts";

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

/** `@actions/artifact` reaches the service with the runtime token and results URL the runner hands a JavaScript action. */
export function artifactServiceAvailable(env: Readonly<NodeJS.ProcessEnv>): boolean {
  return Boolean(env["ACTIONS_RUNTIME_TOKEN"] && env["ACTIONS_RESULTS_URL"]);
}
