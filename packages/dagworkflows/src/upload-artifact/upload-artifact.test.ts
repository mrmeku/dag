import {
  createMemoryFileSystem,
  execute,
  Graph,
  namedOutput,
  settled,
  type MemoryFileSystem,
} from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { manualTimer, memoryRuntime, okExec, steppingClock } from "../memory/index.ts";
import { createMemoryArtifactStore } from "../recording/index.ts";
import { addTask } from "../tasks/index.ts";
import {
  addUpload,
  nullArtifactStore,
  withDefaultExcludes,
  type ArtifactStore,
  type ArtifactUploadOptions,
  type FileMatcher,
  type UploadPorts,
} from "./index.ts";

const WORKSPACE = "/work";
const CACHE_DIR = `${WORKSPACE}/.dag/cache`;
type Ports = UploadPorts & { fs: MemoryFileSystem };
const portsOf = (artifactStore: ArtifactStore, fileMatcher: FileMatcher): Ports => ({
  exec: okExec,
  clock: steppingClock(),
  fs: createMemoryFileSystem(),
  artifactStore,
  fileMatcher,
});
/**
 * Executes `graph` with dagraph's `execute`. `settledOf(name)` is the node's `response` when it
 * succeeded, else its message, and `printed` what each node printed.
 */
async function executeUploads(graph: Graph<UploadPorts>, ports: Ports) {
  const printed = new Map<string, string>();
  const results = await execute(
    graph,
    { ports, fs: ports.fs, clock: ports.clock, startTimer: manualTimer(), cacheDir: CACHE_DIR },
    {
      onEvent: (event) => {
        if (event.type === "output")
          printed.set(event.node, (printed.get(event.node) ?? "") + event.chunk);
      },
    },
  );
  const resultOf = (name: string) => results.find((r) => r.name === name);
  const settledOf = async (name: string): Promise<unknown> => {
    const result = resultOf(name);
    if (result?.status !== "succeeded") return result?.status === "failed" && result.error.message;
    return JSON.parse(
      await ports.fs.readText(namedOutput(result.details.entry.outputs, "response")),
    );
  };
  /** The directory the node committed its outputs in. */
  const dirOf = (name: string) => {
    const result = resultOf(name);
    return (
      result?.status === "succeeded" &&
      `${CACHE_DIR}/v1/${result.details.actionKey}/${result.details.entry.contentHash}`
    );
  };
  return { settledOf, printed, dirOf };
}
/** Adds `pack`, which writes its `tarball`. */
const addPack = (graph: Graph<UploadPorts>) =>
  addTask(graph, {
    name: "pack",
    outputs: { tarball: "pkg.tgz" },
    action: async ({ out, ports }) => ports.fs.writeText(out.tarball, "bytes"),
  });

describe("an upload", () => {
  test("uploads dep outputs from the cache dir rooted at their common directory; a taken name needs overwrite; a failed settled dep is undefined and left out; no service uploads nothing; its response is its output, and it is never cached", async () => {
    const held = createMemoryArtifactStore();
    // Each upload the store took, with the options it was given.
    const taken: [string, ArtifactUploadOptions][] = [];
    const artifactStore: ArtifactStore = {
      upload: async (name, files, rootDirectory, options) => {
        const uploaded = await held.upload(name, files, rootDirectory, options);
        taken.push([name, options]);
        return uploaded;
      },
    };
    const matcher = memoryRuntime().fileMatcher;
    const graph = new Graph<UploadPorts>();
    const pack = addPack(graph);
    const bundle = addTask(graph, {
      name: "bundle",
      outputs: { main: "main.js" },
      action: async ({ out, ports }) => ports.fs.writeText(out.main, "js"),
    });
    const bad = addTask(graph, {
      name: "bad",
      outputs: { report: "report.xml" },
      action: () => {
        throw new Error("tests failed");
      },
    });
    const first = addUpload(graph, {
      name: "upload:tarball",
      artifact: "tarball",
      path: ({ pack }) => [pack.tarball],
      deps: { pack },
      retentionDays: 7,
    });
    addUpload(graph, {
      name: "upload:again",
      artifact: "tarball",
      path: ({ pack }) => [pack.tarball],
      deps: { pack, first },
    });
    const again = addUpload(graph, {
      name: "upload:overwrite",
      artifact: "tarball",
      path: ({ pack }) => [pack.tarball],
      deps: { pack, first },
      overwrite: true,
    });
    const both = addUpload(graph, {
      name: "upload:both",
      artifact: "both",
      path: ({ pack, bundle }) => [pack.tarball, bundle.main],
      deps: { pack, bundle, again },
      compressionLevel: 0,
    });
    addUpload(graph, {
      name: "upload:report",
      artifact: "report",
      path: ({ bad }) => [bad?.report],
      deps: { bad: settled(bad) },
    });
    addUpload(graph, {
      name: "upload:quiet",
      artifact: "quiet",
      path: ["no-such-dir/**"],
      ifNoFilesFound: "ignore",
    });
    addUpload(graph, {
      name: "upload:partial",
      artifact: "partial",
      path: ({ bad, pack }) => [bad?.report, pack.tarball],
      deps: { bad: settled(bad), pack, both },
    });
    const { settledOf, printed, dirOf } = await executeUploads(
      graph,
      portsOf(artifactStore, matcher),
    );
    // The store is the execution's: the upload with no service runs in an execution of its own.
    const offline = new Graph<UploadPorts>();
    const offlinePack = addPack(offline);
    addUpload(offline, {
      name: "upload:offline",
      artifact: "offline",
      path: ({ pack }) => [pack.tarball],
      deps: { pack: offlinePack },
    });
    const offlineRun = await executeUploads(offline, portsOf(nullArtifactStore, matcher));
    const names = [
      "upload:tarball",
      "upload:again",
      "upload:overwrite",
      "upload:both",
      "upload:report",
      "upload:quiet",
      "upload:partial",
    ];
    assert.deepEqual(
      {
        responses: Object.fromEntries(
          await Promise.all(
            names.map(async (n): Promise<[string, unknown]> => [n, await settledOf(n)]),
          ),
        ),
        offline: await offlineRun.settledOf("upload:offline"),
        logs: {
          tarball: printed.get("upload:tarball"),
          report: printed.get("upload:report"),
          quiet: printed.get("upload:quiet"),
          offline: offlineRun.printed.get("upload:offline"),
        },
        uploads: [...held.uploads],
        options: taken,
        uncached: [...graph.describe(), ...offline.describe()]
          .filter((n) => n.name.startsWith("upload:") && n.cacheable === false)
          .map((n) => n.name),
      },
      {
        responses: {
          "upload:tarball": { id: 1, size: 1 },
          "upload:again": "an artifact with this name already exists: tarball",
          "upload:overwrite": { id: 2, size: 1 },
          "upload:both": { id: 3, size: 2 },
          "upload:report": null,
          "upload:quiet": null,
          "upload:partial": { id: 4, size: 1 },
        },
        offline: null,
        logs: {
          tarball:
            "Artifact tarball has been successfully uploaded! Final size is 1 bytes. Artifact ID is 1\n",
          report:
            "::warning title=upload%3Areport::No files were found with the provided path. No artifacts will be uploaded.\n",
          quiet:
            "No files were found with the provided path: no-such-dir/**. No artifacts will be uploaded.\n",
          offline: "Artifact offline not uploaded: no artifact service\n",
        },
        uploads: [
          ["tarball", { files: [`${dirOf("pack")}/pkg.tgz`], rootDirectory: dirOf("pack") }],
          [
            "both",
            {
              files: [`${dirOf("pack")}/pkg.tgz`, `${dirOf("bundle")}/main.js`],
              rootDirectory: `${CACHE_DIR}/v1`,
            },
          ],
          ["partial", { files: [`${dirOf("pack")}/pkg.tgz`], rootDirectory: dirOf("pack") }],
        ],
        options: [
          ["tarball", { retentionDays: 7 }],
          ["tarball", { overwrite: true }],
          ["both", { compressionLevel: 0 }],
          ["partial", {}],
        ],
        uncached: [...names, "upload:offline"],
      },
    );
  });

  test("matches its globs, with the default excludes, when it runs, and roots globs and handles at .; with no files and ifNoFilesFound error it fails, and a matcher that rejects fails it", async () => {
    const artifactStore = createMemoryArtifactStore();
    const seen: string[][] = [];
    const memory = memoryRuntime({ matches: { "reports/**": ["reports/a.txt"] } }).fileMatcher;
    const fileMatcher: FileMatcher = {
      ...memory,
      match: async (patterns) => {
        seen.push(patterns);
        if (patterns.includes("denied/**"))
          throw new Error("EACCES: permission denied, scandir 'denied'");
        return memory.match(patterns);
      },
    };
    const graph = new Graph<UploadPorts>();
    const pack = addPack(graph);
    addUpload(graph, {
      name: "upload:release",
      artifact: "release",
      deps: { pack },
      path: ({ pack }) => ["reports/**", pack.tarball],
    });
    addUpload(graph, {
      name: "upload:required",
      artifact: "required",
      path: ["coverage/**"],
      ifNoFilesFound: "error",
    });
    addUpload(graph, { name: "upload:denied", artifact: "denied", path: ["denied/**"] });
    const { settledOf, dirOf } = await executeUploads(graph, portsOf(artifactStore, fileMatcher));
    assert.deepEqual(
      {
        release: await settledOf("upload:release"),
        required: await settledOf("upload:required"),
        denied: await settledOf("upload:denied"),
        seen: seen.sort(),
        uploads: [...artifactStore.uploads],
      },
      {
        release: { id: 1, size: 2 },
        required:
          "No files were found with the provided path: coverage/**. No artifacts will be uploaded.",
        denied: "EACCES: permission denied, scandir 'denied'",
        seen: [
          withDefaultExcludes(["coverage/**"]),
          withDefaultExcludes(["denied/**"]),
          withDefaultExcludes(["reports/**"]),
        ],
        uploads: [
          ["release", { files: ["reports/a.txt", `${dirOf("pack")}/pkg.tgz`], rootDirectory: "." }],
        ],
      },
    );
  });

  test("excludes .git, node_modules and .dag after its globs", () => {
    assert.deepEqual(withDefaultExcludes(["reports/**"]), [
      "reports/**",
      "!**/.git/**",
      "!**/node_modules/**",
      "!**/.dag/**",
    ]);
  });
});
