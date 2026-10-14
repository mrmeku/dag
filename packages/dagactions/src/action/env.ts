/**
 * What the action's two entries share: the inputs, the resolve hook that serves
 * `@mrmeku/dagactions` from the running bundle (so the workflow file loads before node_modules
 * exists), and the ports: GitHub's reporter, and the toolkit as the cache and artifact services
 * when this process can reach them.
 */
import { DefaultArtifactClient } from "@actions/artifact";
import * as cache from "@actions/cache";
import * as core from "@actions/core";
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

/** The run options the action's inputs describe; `force` is the main entry's alone. */
export async function actionOptions(bundleUrl: string): Promise<RunOptions> {
  registerHooks({
    resolve: (specifier, context, next) =>
      specifier === "@mrmeku/dagactions"
        ? { url: bundleUrl, shortCircuit: true }
        : next(specifier, context),
  });
  const file = core.getInput("workflow", { required: true });
  const def = ((await import(pathToFileURL(resolve(file)).href)) as { default: WorkflowDef })
    .default;
  const ci = createGithubCi({ token: process.env["GITHUB_TOKEN"] });
  if (!cache.isFeatureAvailable())
    core.notice("actions/cache is off: no cache service in this environment", {
      title: "dagactions",
    });
  if (!artifactServiceAvailable(process.env))
    core.notice("actions/upload-artifact is off: no artifact service in this environment", {
      title: "dagactions",
    });
  const only = core.getInput("only").split(",").filter(Boolean);
  return {
    workflow: def.workflow,
    workflowFile: file,
    ports: {
      sh: createSh(),
      fs: createNodeDagFs(),
      clock: systemClock(),
      ci,
      actionsCache: cache.isFeatureAvailable() ? cache : nullActionsCache,
      actionsArtifact: artifactServiceAvailable(process.env)
        ? new DefaultArtifactClient()
        : nullActionsArtifact,
    },
    casBaseDir: core.getInput("cas") || DEFAULT_CAS_DIR,
    journalPath: core.getInput("journal") || DEFAULT_JOURNAL_PATH,
    force: core.getBooleanInput("force"),
    ...(only.length && { only }),
    ...(def.limits && { limits: def.limits }),
    ...(def.summary && { summary: def.summary }),
  };
}
