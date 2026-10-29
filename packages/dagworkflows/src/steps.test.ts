import { execute, Graph, MemCache, namedOutput, settled } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addCommand } from "./commands.ts";
import { errorMessage } from "./kernel/format.ts";
import type { Ports } from "./ports.ts";
import { createActionsArtifactStore, nullArtifactStore } from "./ports/artifact-store.ts";
import { createTestPorts } from "./ports/memory.ts";
import { logPath, uploadArtifact } from "./steps.ts";

const CAS = "/cas";
const newGraph = () => new Graph<Ports>();

const parsed = async (fs: Ports["fs"], path: string): Promise<unknown> =>
  JSON.parse(await fs.readText(path));
/** Executes `graph` under `ports`, on a cache of its own unless given one. */
const executeUnder = (
  graph: Graph<Ports>,
  ports: Ports,
  casBaseDir = CAS,
  cache = new MemCache(),
) => execute(graph, { ports, cache, fs: ports.fs, clock: Date, casBaseDir });

describe("uploadArtifact", () => {
  test("dep outputs upload from the CAS rooted at their common directory; a taken name needs overwrite; a failed settled dep is undefined and left out; no service uploads nothing; the client's response is the output", async () => {
    const {
      ports: p,
      fs,
      artifactStore: service,
    } = createTestPorts({
      exec: {
        run: async ([program, path]) => {
          if (program === "pack" && path) await fs.writeText(path, "bytes");
          if (program === "bundle" && path) await fs.writeText(path, "js");
          return program === "bad"
            ? { ended: "exited", code: 1, stdout: "", stderr: "", output: "", ok: false }
            : { ended: "exited", code: 0, stdout: "", stderr: "", output: "", ok: true };
        },
      },
    });
    const graph = newGraph();
    const pack = addCommand(graph, {
      name: "pack",
      cmd: ({ out }) => ["pack", out.tarball],
      outputs: { tarball: "pkg.tgz" },
    });
    const bundle = addCommand(graph, {
      name: "bundle",
      cmd: ({ out }) => ["bundle", out.main],
      outputs: { main: "main.js" },
    });
    const bad = addCommand(graph, { name: "bad", cmd: ["bad"], outputs: { report: "report.xml" } });
    const first = uploadArtifact(graph, {
      name: "upload:tarball",
      artifact: "tarball",
      path: ({ pack }) => [pack.tarball],
      deps: { pack },
      retentionDays: 7,
    });
    uploadArtifact(graph, {
      name: "upload:again",
      artifact: "tarball",
      path: ({ pack }) => [pack.tarball],
      deps: { pack, first },
    });
    const again = uploadArtifact(graph, {
      name: "upload:overwrite",
      artifact: "tarball",
      path: ({ pack }) => [pack.tarball],
      deps: { pack, first },
      overwrite: true,
    });
    const both = uploadArtifact(graph, {
      name: "upload:both",
      artifact: "both",
      path: ({ pack, bundle }) => [pack.tarball, bundle.main],
      deps: { pack, bundle, again },
    });
    uploadArtifact(graph, {
      name: "upload:report",
      artifact: "report",
      path: ({ bad }) => [bad?.report],
      deps: { bad: settled(bad) },
    });
    uploadArtifact(graph, {
      name: "upload:required",
      artifact: "required",
      path: ({ bad }) => ["no-such-dir/**", bad?.report],
      deps: { bad: settled(bad) },
      ifNoFilesFound: "error",
    });
    uploadArtifact(graph, {
      name: "upload:partial",
      artifact: "partial",
      path: ({ bad, pack }) => [bad?.report, pack.tarball],
      deps: { bad: settled(bad), pack, both },
    });
    // Ports are the execution's: the upload with no service runs in an execution of its own.
    const offline = newGraph();
    uploadArtifact(offline, {
      name: "upload:offline",
      artifact: "offline",
      path: ({ pack }) => [pack.tarball],
      deps: {
        pack: addCommand(offline, {
          name: "pack",
          cmd: ({ out }) => ["pack", out.tarball],
          outputs: { tarball: "pkg.tgz" },
        }),
      },
    });
    const cache = new MemCache();
    const results = await executeUnder(graph, p, CAS, cache);
    const offlineResults = await executeUnder(
      offline,
      { ...p, artifactStore: nullArtifactStore },
      CAS,
      cache,
    );
    // Both graphs have a pack node; graph's result wins over offline's.
    const byName = new Map([...offlineResults, ...results].map((r) => [r.name, r]));
    const out = (name: string) => {
      const r = byName.get(name);
      assert.ok(r, name);
      return r.status === "done" && `${CAS}/${r.actionKey}/out-${r.contentHash}`;
    };
    const json = async (name: string): Promise<unknown> => {
      const r = byName.get(name);
      assert.ok(r, name);
      return r.status === "done"
        ? parsed(fs, namedOutput(r.outputs, "response"))
        : r.status === "failed" && r.error.message;
    };
    const log = async (name: string) => {
      const r = byName.get(name);
      assert.ok(r, name);
      return fs.readText(logPath(CAS, r.actionKey));
    };
    const names = [
      "upload:tarball",
      "upload:again",
      "upload:overwrite",
      "upload:both",
      "upload:report",
      "upload:required",
      "upload:partial",
      "upload:offline",
    ];
    assert.deepEqual(
      {
        outputs: Object.fromEntries(
          await Promise.all(names.map(async (n): Promise<[string, unknown]> => [n, await json(n)])),
        ),
        logs: { tarball: await log("upload:tarball"), report: await log("upload:report") },
        uploads: [...service.uploads],
        uncached: [...graph.describe(), ...offline.describe()]
          .filter((n) => n.cacheable === false)
          .map((n) => n.name),
      },
      {
        outputs: {
          "upload:tarball": { id: 1, size: 1 },
          "upload:again": "an artifact with this name already exists: tarball",
          "upload:overwrite": { id: 2, size: 1 },
          "upload:both": { id: 3, size: 2 },
          "upload:report": null,
          "upload:required":
            "No files were found with the provided path: no-such-dir/**. No artifacts will be uploaded.",
          "upload:partial": { id: 4, size: 1 },
          "upload:offline": null,
        },
        logs: {
          tarball:
            "Artifact tarball has been successfully uploaded! Final size is 1 bytes. Artifact ID is 1\n",
          report:
            "::warning title=upload%3Areport::No files were found with the provided path. No artifacts will be uploaded.\n",
        },
        uploads: [
          ["tarball", { files: [`${out("pack")}/pkg.tgz`], rootDirectory: out("pack") }],
          [
            "both",
            { files: [`${out("pack")}/pkg.tgz`, `${out("bundle")}/main.js`], rootDirectory: CAS },
          ],
          ["partial", { files: [`${out("pack")}/pkg.tgz`], rootDirectory: out("pack") }],
        ],
        // Commands that declare no inputs run every time too.
        uncached: ["pack", "bundle", "bad", ...names.slice(0, -1), "pack", "upload:offline"],
      },
    );
  });
});

describe("the GitHub artifact store", () => {
  test("an overwrite deletes the run's artifact of its name first, a name the run lacks uploads as is, and another failure to delete fails it; options reach the client", async () => {
    const uploads = new Map<string, unknown>();
    const notFound = Object.assign(new Error("Artifact not found"), {
      name: "ArtifactNotFoundError",
    });
    const store = createActionsArtifactStore({
      uploadArtifact: async (name, _files, _root, options) => {
        if (uploads.has(name))
          throw new Error(`an artifact with this name already exists: ${name}`);
        uploads.set(name, options);
        return { id: uploads.size, size: 3 };
      },
      deleteArtifact: async (name) => {
        if (name === "locked") throw new Error("403 Forbidden");
        if (!uploads.delete(name)) throw notFound;
        return { id: 0 };
      },
    });
    const upload = (name: string, overwrite: boolean) =>
      store.upload(name, ["a"], ".", { overwrite, retentionDays: 7 }).catch(errorMessage);
    const outcomes = [
      await upload("report", false),
      await upload("report", false),
      await upload("report", true),
      await upload("fresh", true),
      await upload("locked", true),
    ];
    assert.deepEqual(
      { outcomes, uploads: [...uploads] },
      {
        outcomes: [
          { id: 1, size: 3 },
          "an artifact with this name already exists: report",
          { id: 1, size: 3 },
          { id: 2, size: 3 },
          "403 Forbidden",
        ],
        uploads: [
          ["report", { retentionDays: 7 }],
          ["fresh", { retentionDays: 7 }],
        ],
      },
    );
  });
});
