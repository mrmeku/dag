/**
 * What the action's two entries share: the inputs, the resolve hook that serves
 * `@mrmeku/dagworkflows` from the running bundle (so the workflow file loads before node_modules
 * exists), and the process wired on the bundled toolkit.
 */
import * as artifact from "@actions/artifact";
import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CACHE_DIR } from "../config/index.ts";
import { githubActionsPlatform, type ToolkitLoader } from "../github-actions/index.ts";
import { nodejsRuntime } from "../nodejs/index.ts";
import type { RunOptions } from "../run/index.ts";
import { processPorts, type DagCommand } from "../wiring/index.ts";
import { workflowOf } from "../workflow/index.ts";

const MODULES = {
  "@actions/core": core,
  "@actions/github": github,
  "@actions/cache": cache,
  "@actions/artifact": artifact,
};

/** The toolkit as the bundle holds it. */
const bundledToolkit: ToolkitLoader = {
  load: async (name) => MODULES[name],
  notices: {
    cache: "actions/cache is off: no cache service in this environment",
    artifact: "actions/upload-artifact is off: no artifact service in this environment",
  },
};

/** The run options the action's inputs describe, its process wired for `command`. */
export async function actionOptions(bundleUrl: string, command: DagCommand): Promise<RunOptions> {
  registerHooks({
    resolve: (specifier, context, next) =>
      specifier === "@mrmeku/dagworkflows"
        ? { url: bundleUrl, shortCircuit: true }
        : next(specifier, context),
  });
  const file = core.getInput("workflow", { required: true });
  const def = workflowOf(await import(pathToFileURL(resolve(file)).href), file);
  const only = core.getInput("only").split(",").filter(Boolean);
  const historyDir = core.getInput("history-dir");
  const paths = {
    cacheDir: core.getInput("cache-dir") || DEFAULT_CACHE_DIR,
    ...(historyDir && { historyDir }),
  };
  const { ports } = await processPorts({
    runtime: nodejsRuntime,
    platforms: [githubActionsPlatform(bundledToolkit)],
    paths,
    workflowFile: file,
    command,
    notices: command === "run",
  });
  return {
    ...def,
    ...paths,
    ports,
    workflowFile: file,
    force: core.getBooleanInput("force"),
    ...(only.length && { only }),
  };
}
