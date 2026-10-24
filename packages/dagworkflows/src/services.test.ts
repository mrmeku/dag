import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";

describe("the services the CLI picks", () => {
  test("on GitHub with no cache or artifact service, as in a run: step, neither package is loaded, so neither need be installed", () => {
    const url = (file: string) => JSON.stringify(new URL(file, import.meta.url).pathname);
    // Node's own hooks, so `node` even under `bun test`.
    const r = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
        import { registerHooks } from "node:module";
        registerHooks({
          resolve: (specifier, context, next) => {
            if (specifier === "@actions/cache" || specifier === "@actions/artifact")
              throw new Error("Cannot find package '" + specifier + "' imported from here");
            return next(specifier, context);
          },
        });
        const { pickArtifactStore, pickCacheStore } = await import(${url("./services.ts")});
        const { createRecordingHost, nullArtifactStore, nullCacheStore } = await import(${url("./index.ts")});
        const rec = createRecordingHost();
        const env = { GITHUB_ACTIONS: "true" };
        const cache = (await pickCacheStore(env, rec.host)) === nullCacheStore;
        const artifact = (await pickArtifactStore(env, rec.host)) === nullArtifactStore;
        console.log(JSON.stringify({ cache, artifact, notices: rec.annotations.map((a) => a.message) }));
        `,
      ],
      { encoding: "utf8" },
    );
    const out: unknown = JSON.parse(r.stdout || "null");
    assert.deepEqual(
      { status: r.status, stderr: r.stderr, out },
      {
        status: 0,
        stderr: "",
        out: {
          cache: true,
          artifact: true,
          notices: [
            "actions/cache is off: this step cannot reach the cache service; use the action instead of `dag run`",
            "actions/upload-artifact is off: this step cannot reach the artifact service; use the action instead of `dag run`",
          ],
        },
      },
    );
  });
});
