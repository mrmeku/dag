import type { ArtifactClient } from "@actions/artifact";
import { errorMessage } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, test } from "node:test";
import { artifactServiceAvailable, createActionsArtifactStore } from "./index.ts";

/** The working directory the client double resolves paths against, as the client resolves them against the process's. */
const WORKSPACE = "/home/runner/work/repo";

/**
 * An `@actions/artifact` client as the service answers it: a name uploads once unless deleted, a
 * file outside the root is refused in the client's words, and deleting `locked` is forbidden.
 */
function artifactClient() {
  const uploads = new Map<string, unknown>();
  const client: Pick<ArtifactClient, "uploadArtifact" | "deleteArtifact"> = {
    uploadArtifact: async (name, files, rootDirectory, options) => {
      const root = resolve(WORKSPACE, rootDirectory);
      for (const file of files.map((f) => resolve(WORKSPACE, f)))
        if (!file.startsWith(root))
          throw new Error(
            `The rootDirectory: ${root} is not a parent directory of the file: ${file}`,
          );
      if (uploads.has(name)) throw new Error(`an artifact with this name already exists: ${name}`);
      uploads.set(name, options);
      return name === "empty" ? {} : { id: uploads.size, ...(name !== "unsized" && { size: 3 }) };
    },
    deleteArtifact: async (name) => {
      if (name === "locked") throw new Error("403 Forbidden");
      if (!uploads.delete(name))
        throw Object.assign(new Error("Artifact not found"), { name: "ArtifactNotFoundError" });
      return { id: 0 };
    },
  };
  return { client, uploads };
}

describe("the GitHub artifact store", () => {
  test("an overwrite deletes the run's artifact of its name first, a name the run lacks uploads as is, and another failure to delete fails it; only the options set reach the client; a response without an id is nothing, and without a size 0", async () => {
    const { client, uploads } = artifactClient();
    const store = createActionsArtifactStore(client);
    const upload = (name: string, overwrite: boolean) =>
      store.upload(name, ["a"], ".", { overwrite, retentionDays: 7 }).catch(errorMessage);
    const outcomes = [
      await upload("report", false),
      await upload("report", false),
      await upload("report", true),
      await upload("fresh", true),
      await upload("locked", true),
      await upload("empty", false),
      await upload("unsized", false),
      await store.upload("fast", ["a"], ".", { compressionLevel: 0 }),
    ];
    assert.deepEqual(
      { outcomes, uploads: [...uploads] },
      {
        outcomes: [
          { id: 1, size: 3 },
          "an artifact with this name already exists: report",
          { id: 1, size: 3 },
          { id: 2, size: 3 },
          "403 Forbidden",
          undefined,
          { id: 4, size: 0 },
          { id: 5, size: 3 },
        ],
        uploads: [
          ["report", { retentionDays: 7 }],
          ["fresh", { retentionDays: 7 }],
          ["empty", { retentionDays: 7 }],
          ["unsized", { retentionDays: 7 }],
          ["fast", { compressionLevel: 0 }],
        ],
      },
    );
  });

  test("rejects unchanged when the client refuses a root . that is not a parent of a file", async () => {
    const store = createActionsArtifactStore(artifactClient().client);
    const tarball = "/home/runner/.dag/cache/v1/key/hash/pkg.tgz";
    await assert.rejects(store.upload("pack", ["reports/a.txt", tarball], ".", {}), {
      message: `The rootDirectory: ${WORKSPACE} is not a parent directory of the file: ${tarball}`,
    });
  });

  test("reaches the service with both the runtime token and the results URL", () => {
    const token = { ACTIONS_RUNTIME_TOKEN: "t" };
    const url = { ACTIONS_RESULTS_URL: "https://results" };
    assert.deepEqual(
      [
        artifactServiceAvailable(token),
        artifactServiceAvailable(url),
        artifactServiceAvailable({ ...token, ...url }),
      ],
      [false, false, true],
    );
  });
});
