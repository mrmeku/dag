import type { ExecutionEvent } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { nullCacheStore, type CacheStore } from "../actions-cache/index.ts";
import { nullHost } from "../host/index.ts";
import { memoryRuntime } from "../memory/index.ts";
import type { RunListener } from "../run-store/index.ts";
import { nullArtifactStore, type ArtifactStore } from "../upload-artifact/index.ts";
import { processPorts, type Platform, type PlatformOptions } from "./index.ts";

/** What the doubles were asked: each platform made, with what, each member made, and the runtime's signal handling. */
interface Asked {
  made: Array<{ name: string; env: Readonly<NodeJS.ProcessEnv>; options: PlatformOptions }>;
  members: string[];
  notices: Array<{ on: string; level: string; title: string; message: string }>;
}

/** A platform double: its own host, which records annotations, and stores that are off when it has words for them. */
function platformDouble(
  asked: Asked,
  name: string,
  opts: { listeners?: RunListener[]; cacheOff?: string; artifactOff?: string } = {},
) {
  const host = {
    ...nullHost(),
    annotate: (level: string, title: string, message: string) =>
      void asked.notices.push({ on: name, level, title, message }),
  };
  const cacheStore: CacheStore = { ...nullCacheStore };
  const artifactStore: ArtifactStore = { ...nullArtifactStore };
  const platform: Platform = (runtime, options) => {
    asked.made.push({ name, env: runtime.env, options });
    const recorded = <T>(member: string, made: T) => {
      asked.members.push(`${name} ${member}`);
      return Promise.resolve(made);
    };
    return {
      name,
      host: () => recorded("host", host),
      listeners: () => recorded("listeners", opts.listeners),
      cacheStore: () =>
        recorded("cacheStore", {
          store: cacheStore,
          ...(opts.cacheOff && { notice: opts.cacheOff }),
        }),
      artifactStore: () =>
        recorded("artifactStore", {
          store: artifactStore,
          ...(opts.artifactOff && { notice: opts.artifactOff }),
        }),
    };
  };
  return { platform, host, cacheStore, artifactStore };
}

const nothingAsked = (): Asked => ({ made: [], members: [], notices: [] });
/** A memory runtime with `env`, which records being asked for its signal handling. */
const runtimeWith = (asked: Asked, env: Record<string, string>) => ({
  ...memoryRuntime(),
  env,
  abortOnSignals: () => {
    asked.members.push("runtime abortOnSignals");
    return new AbortController().signal;
  },
});
const paths = { cacheDir: ".dag/cache" };
/** What the engine tells of a node it builds, which prints a line. */
const lintBuildEvents: ExecutionEvent[] = [
  { type: "dispatch", node: "lint", occurredAt: 0 },
  { type: "start", node: "lint", occurredAt: 0 },
  { type: "output", node: "lint", chunk: "linted\n", occurredAt: 0 },
  {
    type: "result",
    node: "lint",
    result: {
      name: "lint",
      status: "succeeded",
      details: {
        actionKey: "k",
        entry: { outputs: {}, contentHash: "h", outputHashes: {} },
        actionRan: true,
        elapsed: 1000,
      },
    },
    occurredAt: 1000,
  },
];

describe("processPorts", () => {
  test("GITHUB_ACTIONS=true chooses GitHub's double, its host and stores in the ports, the runtime's members beside them, and no store when it gives no display", async () => {
    const asked = nothingAsked();
    const local = platformDouble(asked, "local", { listeners: [] });
    const github = platformDouble(asked, "github-actions");
    const runtime = runtimeWith(asked, { GITHUB_ACTIONS: "true" });
    const { ports, store } = await processPorts({
      runtime,
      platforms: [local.platform, github.platform],
      display: { style: "live" },
      paths,
      workflowFile: "ci.ts",
      command: "run",
      notices: true,
    });
    const options = { display: { style: "live" }, paths, command: "run", workflowFile: "ci.ts" };
    assert.deepEqual(
      {
        asked,
        chosen: [
          ports.host === github.host,
          ports.cacheStore === github.cacheStore,
          ports.artifactStore === github.artifactStore,
        ],
        runtime: (
          ["exec", "clock", "startTimer", "fs", "lockfile", "fileMatcher", "env"] as const
        ).every((port) => ports[port] === runtime[port]),
        store,
      },
      {
        asked: {
          made: [
            { name: "local", env: runtime.env, options },
            { name: "github-actions", env: runtime.env, options },
          ],
          members: [
            "github-actions host",
            "github-actions cacheStore",
            "github-actions artifactStore",
            "github-actions listeners",
          ],
          notices: [],
        },
        chosen: [true, true, true],
        runtime: true,
        store: undefined,
      },
    );
  });

  test("a lone platform is chosen with GITHUB_ACTIONS unset, and a display it gives makes a store that keeps build logs and durations in the run's dirs, config's unless given", async () => {
    const wiringWith = async (runPaths: PlatformOptions["paths"]) => {
      const asked = nothingAsked();
      const runtime = runtimeWith(asked, {});
      const github = platformDouble(asked, "github-actions", { listeners: [] });
      const { ports, store } = await processPorts({
        runtime,
        platforms: [github.platform],
        paths: runPaths,
        workflowFile: "ci.ts",
        command: "run",
      });
      store?.begin({ title: "main", nodes: [{ name: "lint", kind: "lint", deps: [] }] });
      lintBuildEvents.forEach((event) => store?.onEvent(event));
      await store?.writeDurations();
      return { host: ports.host === github.host, files: [...runtime.fs.files.keys()].sort() };
    };
    assert.deepEqual(
      {
        given: await wiringWith({
          cacheDir: "/c",
          buildLogDir: "/logs",
          durationsDir: "/durations",
        }),
        defaults: await wiringWith(paths),
      },
      {
        given: { host: true, files: ["/durations/ci.ts.json", "/logs/k.log"] },
        defaults: { host: true, files: [".dag/build-logs/k.log", ".dag/durations/ci.ts.json"] },
      },
    );
  });

  test("a platform choice brings its host and display, and the stores stay the detected platform's", async () => {
    const asked = nothingAsked();
    const local = platformDouble(asked, "local");
    const github = platformDouble(asked, "github-actions");
    const { ports } = await processPorts({
      runtime: runtimeWith(asked, {}),
      platforms: [local.platform, github.platform],
      choices: { platform: "github-actions" },
      paths,
      command: "run",
    });
    assert.deepEqual(
      {
        chosen: [
          ports.host === github.host,
          ports.cacheStore === local.cacheStore,
          ports.artifactStore === local.artifactStore,
        ],
        members: asked.members,
      },
      {
        chosen: [true, true, true],
        members: [
          "github-actions host",
          "local cacheStore",
          "local artifactStore",
          "github-actions listeners",
        ],
      },
    );
  });

  test("the detected platform's cache store off: one notice titled dag on the chosen host, in that platform's words, and none without notices", async () => {
    const noticesWith = async (notices: boolean) => {
      const asked = nothingAsked();
      const local = platformDouble(asked, "local", { cacheOff: "local cache is off" });
      const github = platformDouble(asked, "github-actions", { cacheOff: "github cache is off" });
      await processPorts({
        runtime: runtimeWith(asked, {}),
        platforms: [local.platform, github.platform],
        paths,
        command: "run",
        notices,
      });
      return asked.notices;
    };
    assert.deepEqual(
      { notices: await noticesWith(true), quiet: await noticesWith(false) },
      {
        notices: [{ on: "local", level: "notice", title: "dag", message: "local cache is off" }],
        quiet: [],
      },
    );
  });

  test("a store override naming a platform whose store is off gives that platform's notice, once, on the chosen host; none gives the null store and no notice", async () => {
    const asked = nothingAsked();
    const local = platformDouble(asked, "local");
    const github = platformDouble(asked, "github-actions", {
      cacheOff: "github cache is off",
      artifactOff: "github artifacts are off",
    });
    const { ports } = await processPorts({
      runtime: runtimeWith(asked, {}),
      platforms: [local.platform, github.platform],
      choices: { cacheStore: "github-actions", artifactStore: "none" },
      paths,
      command: "run",
      notices: true,
    });
    assert.deepEqual(
      {
        notices: asked.notices,
        members: asked.members,
        cacheStore: ports.cacheStore === github.cacheStore,
        artifactStore: ports.artifactStore === nullArtifactStore,
      },
      {
        notices: [{ on: "local", level: "notice", title: "dag", message: "github cache is off" }],
        members: ["local host", "github-actions cacheStore", "local listeners"],
        cacheStore: true,
        artifactStore: true,
      },
    );
  });

  test("a platform not offered is refused, whether a choice names it or it is detected among several", async () => {
    const refusalOf = (env: Record<string, string>, choices: Record<string, string>) => {
      const asked = nothingAsked();
      return processPorts({
        runtime: runtimeWith(asked, env),
        platforms: [
          platformDouble(asked, "github-actions").platform,
          platformDouble(asked, "recording").platform,
        ],
        choices,
        paths,
        command: "run",
      }).then(
        () => "wired",
        (e: unknown) => (e instanceof Error ? e.message : e),
      );
    };
    assert.deepEqual(
      {
        named: await refusalOf({ GITHUB_ACTIONS: "true" }, { platform: "local" }),
        store: await refusalOf({ GITHUB_ACTIONS: "true" }, { cacheStore: "local" }),
        detected: await refusalOf({ GITHUB_ACTIONS: "1" }, {}),
      },
      {
        named: "platform local is not offered here",
        store: "cache store local is not offered here",
        detected: "platform local is not offered here",
      },
    );
  });
});
