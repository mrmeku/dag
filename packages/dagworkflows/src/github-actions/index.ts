import { nullCacheStore } from "../actions-cache/index.ts";
import type { Host } from "../host/index.ts";
import { nullArtifactStore } from "../upload-artifact/index.ts";
import type { Platform } from "../wiring/index.ts";
import { artifactServiceAvailable, createActionsArtifactStore } from "./artifact-store/index.ts";
import { createActionsCacheStore } from "./cache-store/index.ts";
import { createActionsHost } from "./host/index.ts";

export { artifactServiceAvailable, createActionsArtifactStore } from "./artifact-store/index.ts";
export { createActionsCacheStore } from "./cache-store/index.ts";

/** The toolkit modules the platform loads, by name. */
export interface ToolkitModules {
  "@actions/core": typeof import("@actions/core");
  "@actions/github": typeof import("@actions/github");
  "@actions/cache": typeof import("@actions/cache");
  "@actions/artifact": typeof import("@actions/artifact");
}

/**
 * How the process gives the platform the toolkit: `load` resolves to a module or refuses a
 * missing one in the filler's words; `cacheVariablesRequired`, whether `@actions/cache` may be
 * loaded only once `ACTIONS_CACHE_URL` or `ACTIONS_RESULTS_URL` is set, as an optional peer must;
 * `notices`, the filler's words for the cache and the artifact service being off.
 */
export interface ToolkitLoader {
  load: <Name extends keyof ToolkitModules>(name: Name) => Promise<ToolkitModules[Name]>;
  cacheVariablesRequired?: boolean;
  notices: { cache: string; artifact: string };
}

/**
 * Running in a GitHub Actions job: the toolkit's context, log and check runs on one host, made
 * once; `run/`'s default display on it; and the cache and artifact services when this process can
 * reach them, else the null stores with the loader's notices.
 */
export function githubActionsPlatform(loader: ToolkitLoader): Platform {
  return (runtime) => {
    let host: Promise<Host> | undefined;
    return {
      name: "github-actions",
      host: () =>
        (host ??= Promise.all([loader.load("@actions/core"), loader.load("@actions/github")]).then(
          ([core, github]) => createActionsHost({ core, github, token: runtime.env.GITHUB_TOKEN }),
        )),
      listeners: async () => undefined,
      cacheStore: async () => {
        if (
          !loader.cacheVariablesRequired ||
          runtime.env.ACTIONS_CACHE_URL ||
          runtime.env.ACTIONS_RESULTS_URL
        ) {
          const cache = await loader.load("@actions/cache");
          if (cache.isFeatureAvailable()) return { store: createActionsCacheStore(cache) };
        }
        return { store: nullCacheStore, notice: loader.notices.cache };
      },
      artifactStore: async () => {
        if (!artifactServiceAvailable(runtime.env))
          return { store: nullArtifactStore, notice: loader.notices.artifact };
        const { DefaultArtifactClient } = await loader.load("@actions/artifact");
        return { store: createActionsArtifactStore(new DefaultArtifactClient()) };
      },
    };
  };
}
