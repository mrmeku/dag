/**
 * What the action's two entries share: the inputs, the resolve hook that serves
 * `@mrmeku/dagworkflows` from the running bundle (so the workflow file loads before node_modules
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
import { check, lock } from "proper-lockfile";
import { DEFAULT_CAS_DIR, DEFAULT_HISTORY_DIR } from "../config.ts";
import { artifactServiceAvailable, nullActionsArtifact } from "../ports/actions-artifact.ts";
import { nullActionsCache } from "../ports/actions-cache.ts";
import { createGithubHost } from "../ports/github.ts";
import { createExec, systemClock } from "../ports/real.ts";
import type { RunOptions } from "../runner.ts";
import { workflowDefOf } from "../workflow.ts";

/** Notices for the services this process cannot reach; the main entry's alone, so once a job. */
export function noticeUnavailableServices(): void {
  if (!cache.isFeatureAvailable())
    core.notice("actions/cache is off: no cache service in this environment", {
      title: "dag",
    });
  if (!artifactServiceAvailable(process.env))
    core.notice("actions/upload-artifact is off: no artifact service in this environment", {
      title: "dag",
    });
}

/** The run options the action's inputs describe; `force` is the main entry's alone. */
export async function actionOptions(bundleUrl: string): Promise<RunOptions> {
  registerHooks({
    resolve: (specifier, context, next) =>
      specifier === "@mrmeku/dagworkflows"
        ? { url: bundleUrl, shortCircuit: true }
        : next(specifier, context),
  });
  const file = core.getInput("workflow", { required: true });
  const def = workflowDefOf(await import(pathToFileURL(resolve(file)).href), file);
  const host = createGithubHost({ token: process.env["GITHUB_TOKEN"] });
  const only = core.getInput("only").split(",").filter(Boolean);
  return {
    implementation: def.implementation,
    workflowFile: file,
    ports: {
      exec: createExec(),
      fs: createNodeDagFs(),
      clock: systemClock(),
      host,
      actionsCache: cache.isFeatureAvailable() ? cache : nullActionsCache,
      actionsArtifact: artifactServiceAvailable(process.env)
        ? new DefaultArtifactClient()
        : nullActionsArtifact,
      lockfile: { lock, check },
      env: process.env,
    },
    casBaseDir: core.getInput("cas-dir") || DEFAULT_CAS_DIR,
    historyDir: core.getInput("history-dir") || DEFAULT_HISTORY_DIR,
    force: core.getBooleanInput("force"),
    ...(only.length && { only }),
    ...(def.schedulerOptions && { schedulerOptions: def.schedulerOptions }),
    ...(def.summary && { summary: def.summary }),
  };
}
