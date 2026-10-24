/**
 * The toolkit's services as the CLI picks them, apart from cli.ts so that a test can load them on
 * any Node. On GitHub they are optional peer dependencies, loaded only when a service is there.
 */
import type { ArtifactStore, CacheStore, Host, Ports } from "./ports.ts";
import {
  artifactServiceAvailable,
  createActionsArtifactStore,
  nullArtifactStore,
} from "./ports/artifact-store.ts";
import { createActionsCacheStore, nullCacheStore } from "./ports/cache-store.ts";

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
      `dag needs ${missing} on GitHub, an optional peer dependency it does not install: ` +
        `add it (npm install --save-dev ${missing}), or use the action, which bundles it, instead of \`dag run\``,
      { cause: e },
    );
  }
}

/**
 * On GitHub, `@actions/cache` is the cache store when this process can reach its service. That takes the
 * service URL only a JavaScript action receives, so a `run:` step gets a notice and no cache, and
 * need not install the package; the toolkit's isFeatureAvailable decides once one is there.
 * Locally the cache is what the worktrees hold on disk (`createWorktreeCacheStore`).
 */
export async function pickCacheStore(env: Ports["env"], host: Host): Promise<CacheStore> {
  if (env.ACTIONS_CACHE_URL || env.ACTIONS_RESULTS_URL) {
    const cache = await peer(() => import("@actions/cache"));
    if (cache.isFeatureAvailable()) return createActionsCacheStore(cache);
  }
  host.annotate(
    "notice",
    "dag",
    "actions/cache is off: this step cannot reach the cache service; use the action instead of `dag run`",
  );
  return nullCacheStore;
}

/** `@actions/artifact` likewise: the service takes the runtime token only the action receives. */
export async function pickArtifactStore(env: Ports["env"], host: Host): Promise<ArtifactStore> {
  if (env.GITHUB_ACTIONS !== "true") return nullArtifactStore;
  if (artifactServiceAvailable(env)) {
    const { DefaultArtifactClient } = await peer(() => import("@actions/artifact"));
    return createActionsArtifactStore(new DefaultArtifactClient());
  }
  host.annotate(
    "notice",
    "dag",
    "actions/upload-artifact is off: this step cannot reach the artifact service; use the action instead of `dag run`",
  );
  return nullArtifactStore;
}
