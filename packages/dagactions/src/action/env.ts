/**
 * What the action's two entries share: inputs from INPUT_* variables, the resolve hook that
 * serves `@mrmeku/dagactions` from the running bundle (so the workflow file loads before
 * node_modules exists), and the ports: GitHub's reporter, and the toolkit as the cache and
 * artifact services when this process can reach them.
 */
import { DefaultArtifactClient } from "@actions/artifact";
import * as cache from "@actions/cache";
import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CAS_DIR, DEFAULT_JOURNAL_PATH } from "../config.ts";
import { artifactServiceAvailable, nullActionsArtifact } from "../ports/actions-artifact.ts";
import { nullActionsCache } from "../ports/actions-cache.ts";
import { createGithubCi } from "../ports/github.ts";
import { createSh, systemClock } from "../ports/real.ts";
import type { RunOptions } from "../runner.ts";
import type { WorkflowDef } from "../workflow.ts";

const input = (name: string): string | undefined =>
  process.env[`INPUT_${name.toUpperCase()}`]?.trim() || undefined;

/** The run options the action's inputs describe; `force` is the main entry's alone. */
export async function actionOptions(bundleUrl: string): Promise<RunOptions> {
  registerHooks({
    resolve: (specifier, context, next) =>
      specifier === "@mrmeku/dagactions"
        ? { url: bundleUrl, shortCircuit: true }
        : next(specifier, context),
  });
  const file = input("workflow");
  if (!file) throw new Error("the `workflow` input is required");
  const def = ((await import(pathToFileURL(resolve(file)).href)) as { default: WorkflowDef })
    .default;
  const fs = createNodeDagFs();
  const ci = createGithubCi({ env: process.env, fs });
  if (!cache.isFeatureAvailable()) {
    ci.annotate(
      "notice",
      "dagactions",
      "actions/cache is off: no cache service in this environment",
    );
  }
  if (!artifactServiceAvailable(process.env)) {
    ci.annotate(
      "notice",
      "dagactions",
      "actions/upload-artifact is off: no artifact service in this environment",
    );
  }
  const only = input("only")?.split(",").filter(Boolean);
  return {
    workflow: def.workflow,
    ports: {
      sh: createSh(),
      fs,
      clock: systemClock(),
      ci,
      actionsCache: cache.isFeatureAvailable() ? cache : nullActionsCache,
      actionsArtifact: artifactServiceAvailable(process.env)
        ? new DefaultArtifactClient()
        : nullActionsArtifact,
    },
    casBaseDir: input("cas") ?? DEFAULT_CAS_DIR,
    journalPath: input("journal") ?? DEFAULT_JOURNAL_PATH,
    force: input("force") === "true",
    ...(only && { only }),
    ...(def.limits && { limits: def.limits }),
  };
}
