/**
 * The toolkit's services as the CLI picks them, apart from cli.ts so that a test can load them on
 * any Node. On GitHub they are optional peer dependencies, loaded only when a service is there.
 */
import type { ActionsArtifact, ActionsCache, Ci } from "./ports.ts";
import { artifactServiceAvailable, nullActionsArtifact } from "./ports/actions-artifact.ts";
import { nullActionsCache } from "./ports/actions-cache.ts";

type Env = Record<string, string | undefined>;

/**
 * A module of the actions toolkit, which the CLI loads on GitHub alone and the package lists as
 * optional peer dependencies: a missing one is named, with what to do about it.
 */
export async function peer<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (e) {
    const missing = /Cannot find package '(@actions\/[^']+)'/.exec(String(e))?.[1];
    if (missing === undefined) throw e;
    throw new Error(
      `dagactions needs ${missing} on GitHub, an optional peer dependency it does not install: ` +
        `add it (npm install --save-dev ${missing}), or run dagactions as the action, which bundles it`,
      { cause: e },
    );
  }
}

/**
 * `@actions/cache` is the cache service when this process can reach it. That takes the service
 * URL only a JavaScript action receives, so a `run:` step gets a notice and no cache, and need
 * not install the package; the toolkit's isFeatureAvailable decides once one is there. Locally
 * there is no service, so every restore misses.
 */
export async function pickActionsCache(env: Env, ci: Ci): Promise<ActionsCache> {
  if (env.GITHUB_ACTIONS !== "true") return nullActionsCache;
  if (env.ACTIONS_CACHE_URL || env.ACTIONS_RESULTS_URL) {
    const cache = await peer(() => import("@actions/cache"));
    if (cache.isFeatureAvailable()) return cache;
  }
  ci.annotate(
    "notice",
    "dagactions",
    "actions/cache is off: this step cannot reach the cache service; run dagactions as the action",
  );
  return nullActionsCache;
}

/** `@actions/artifact` likewise: the service takes the runtime token only the action receives. */
export async function pickActionsArtifact(env: Env, ci: Ci): Promise<ActionsArtifact> {
  if (env.GITHUB_ACTIONS !== "true") return nullActionsArtifact;
  if (artifactServiceAvailable(env)) {
    const { DefaultArtifactClient } = await peer(() => import("@actions/artifact"));
    return new DefaultArtifactClient();
  }
  ci.annotate(
    "notice",
    "dagactions",
    "actions/upload-artifact is off: this step cannot reach the artifact service; run dagactions as the action",
  );
  return nullActionsArtifact;
}
