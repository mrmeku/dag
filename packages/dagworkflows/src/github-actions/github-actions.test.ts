import * as artifact from "@actions/artifact";
import * as cache from "@actions/cache";
import * as core from "@actions/core";
import * as github from "@actions/github";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { nullCacheStore } from "../actions-cache/index.ts";
import { memoryRuntime } from "../memory/index.ts";
import { nullArtifactStore } from "../upload-artifact/index.ts";
import type { PlatformOptions } from "../wiring/index.ts";
import { githubActionsPlatform, type ToolkitLoader, type ToolkitModules } from "./index.ts";

const NOTICES = { cache: "cache is off here", artifact: "artifacts are off here" };

/** A loader that gives only `modules`, failing for any other, and records what it was asked. */
function loaderDouble(modules: Partial<ToolkitModules>, cacheVariablesRequired: boolean) {
  const loaded: string[] = [];
  const loader: ToolkitLoader = {
    load: async (name) => {
      loaded.push(name);
      const module = modules[name];
      if (!module) throw new Error(`${name} was loaded unasked`);
      return module;
    },
    cacheVariablesRequired,
    notices: NOTICES,
  };
  return { loader, loaded };
}

/** `@actions/github` with a push's context, as the runner's environment gives it. */
const githubDouble = {
  ...github,
  context: {
    payload: {},
    eventName: "push",
    sha: "abc",
    ref: "refs/heads/main",
    workflow: "ci",
    action: "dag",
    actor: "octocat",
    job: "build",
    runAttempt: 1,
    runNumber: 1,
    runId: 42,
    apiUrl: "https://api.github.com",
    serverUrl: "https://github.com",
    graphqlUrl: "https://api.github.com/graphql",
    issue: { owner: "acme", repo: "app", number: 0 },
    repo: { owner: "acme", repo: "app" },
  },
};

const runOptions: PlatformOptions = {
  display: {},
  paths: { cacheDir: ".dag/cache" },
  command: "run",
  workflowFile: "ci.ts",
};
const membersOf = (loader: ToolkitLoader, env: Record<string, string>, options = runOptions) =>
  githubActionsPlatform(loader)({ ...memoryRuntime(), env }, options);

describe("the GitHub Actions platform", () => {
  test("in a run: step with neither cache variable, the cache module is never loaded, and both stores are the null ones with the loader's notices", async () => {
    const { loader, loaded } = loaderDouble({}, true);
    const members = membersOf(loader, { GITHUB_ACTIONS: "true" });
    const cacheStore = await members.cacheStore();
    const artifactStore = await members.artifactStore();
    assert.deepEqual(
      {
        loaded,
        cacheStore: cacheStore.store === nullCacheStore,
        artifactStore: artifactStore.store === nullArtifactStore,
        notices: [cacheStore.notice, artifactStore.notice],
      },
      {
        loaded: [],
        cacheStore: true,
        artifactStore: true,
        notices: [NOTICES.cache, NOTICES.artifact],
      },
    );
  });

  test("the cache service is reachable when the loader needs no cache variable or one is set, and the service says it is available", async () => {
    const storeFor = async (
      cacheVariablesRequired: boolean,
      env: Record<string, string>,
      available: boolean,
    ) => {
      const { loader, loaded } = loaderDouble(
        { "@actions/cache": { ...cache, isFeatureAvailable: () => available } },
        cacheVariablesRequired,
      );
      const { store, notice } = await membersOf(loader, env).cacheStore();
      return { loaded, nullStore: store === nullCacheStore, notice };
    };
    const off = (loaded: string[]) => ({ loaded, nullStore: true, notice: NOTICES.cache });
    const on = { loaded: ["@actions/cache"], nullStore: false, notice: undefined };
    assert.deepEqual(
      {
        cacheUrl: await storeFor(true, { ACTIONS_CACHE_URL: "https://cache" }, true),
        resultsUrl: await storeFor(true, { ACTIONS_RESULTS_URL: "https://results" }, true),
        unavailable: await storeFor(true, { ACTIONS_RESULTS_URL: "https://results" }, false),
        noVariableNeeded: await storeFor(false, {}, true),
        noVariableNeededUnavailable: await storeFor(false, {}, false),
      },
      {
        cacheUrl: on,
        resultsUrl: on,
        unavailable: off(["@actions/cache"]),
        noVariableNeeded: on,
        noVariableNeededUnavailable: off(["@actions/cache"]),
      },
    );
  });

  test("with the runtime token and the results URL, the artifact store is @actions/artifact's client, with no notice", async () => {
    const { loader, loaded } = loaderDouble(
      {
        "@actions/artifact": {
          ...artifact,
          DefaultArtifactClient: class extends artifact.DefaultArtifactClient {
            override async uploadArtifact() {
              return { id: 9, size: 1 };
            }
          },
        },
      },
      true,
    );
    const members = membersOf(loader, {
      ACTIONS_RUNTIME_TOKEN: "t",
      ACTIONS_RESULTS_URL: "https://results",
    });
    const { store, notice } = await members.artifactStore();
    assert.deepEqual(
      { loaded, notice, uploaded: await store.upload("a", ["f"], ".", {}) },
      { loaded: ["@actions/artifact"], notice: undefined, uploaded: { id: 9, size: 1 } },
    );
  });

  test("a toolkit module the loader refuses rejects host() in the loader's words", async () => {
    const { loader } = loaderDouble({}, true);
    await assert.rejects(membersOf(loader, { GITHUB_ACTIONS: "true" }).host(), {
      message: "@actions/core was loaded unasked",
    });
  });

  test("check runs take GITHUB_TOKEN from the runtime's environment, never the process's", async () => {
    const authorizations = async (env: Record<string, string>) => {
      const sent: Array<string | null> = [];
      const fetch = Object.assign(
        async (...[, init]: Parameters<typeof globalThis.fetch>) => {
          sent.push(new Headers(init?.headers).get("authorization"));
          return Response.json({ id: 1 }, { status: 201 });
        },
        { preconnect: () => {} },
      );
      const { loader } = loaderDouble(
        {
          "@actions/core": core,
          "@actions/github": {
            ...githubDouble,
            getOctokit: (token: string) => github.getOctokit(token, { request: { fetch } }),
          },
        },
        true,
      );
      await (await membersOf(loader, env).host()).check({ name: "n", status: "in_progress" });
      return sent;
    };
    const processToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "from-process";
    try {
      assert.deepEqual(
        { runtime: await authorizations({ GITHUB_TOKEN: "t" }), none: await authorizations({}) },
        { runtime: ["token t"], none: [] },
      );
    } finally {
      if (processToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = processToken;
    }
  });

  // The real toolkit's summary, so the host is held to its words; with the variable unset it
  // writes nowhere, here or in the job running these tests.
  test("given a local display, it makes none, and a summary with no step summary file reaches the log through core.info", async () => {
    const info: string[] = [];
    const { loader, loaded } = loaderDouble(
      {
        "@actions/core": { ...core, info: (line: string) => void info.push(line) },
        "@actions/github": githubDouble,
      },
      true,
    );
    const members = membersOf(
      loader,
      { GITHUB_ACTIONS: "true" },
      {
        ...runOptions,
        display: { style: "live", logDir: "out/logs", summaryFile: "out/s.md" },
      },
    );
    const stepSummary = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_STEP_SUMMARY;
    try {
      const host = await members.host();
      await host.summary("## ci.ts");
      assert.deepEqual(
        {
          listeners: await members.listeners(),
          sameHost: host === (await members.host()),
          loaded,
          info,
        },
        {
          listeners: undefined,
          sameHost: true,
          loaded: ["@actions/core", "@actions/github"],
          info: ["## ci.ts"],
        },
      );
    } finally {
      if (stepSummary !== undefined) process.env.GITHUB_STEP_SUMMARY = stepSummary;
    }
  });
});
