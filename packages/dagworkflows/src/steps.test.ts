import { execute, Graph, MemCache, settled, soleOutput } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addCommand } from "./commands.ts";
import type { Exec, Ports } from "./ports.ts";
import { nullActionsArtifact } from "./ports/actions-artifact.ts";
import { createMemoryActionsCache } from "./ports/actions-cache.ts";
import { createTestPorts } from "./ports/memory.ts";
import { logPath, postNodes, restoreCache, saveCache, uploadArtifact } from "./steps.ts";

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
) => execute(graph, { ports, cache, fs: ports.fs, casBaseDir });

const ERR = Array.from({ length: 30 }, (_, i) => `err ${i + 1}`).join("\n") + "\n";
/** A shell whose only commands are `ok` (exit 0) and `bad` (exit 1 with a long stderr). */
const fakeExec: Exec = {
  run: async (cmd) =>
    cmd[0] === "ok"
      ? { code: 0, stdout: "hello\n", stderr: "", output: "hello\n", ok: true }
      : {
          code: 1,
          stdout: "",
          stderr: ERR,
          output: ERR,
          ok: false,
        },
};

describe("restoreCache + saveCache", () => {
  test("a restore-key match restores the newest prefix match and saves the primary key; an exact hit saves nothing; a refused save warns; the outputs are what the toolkit returned", async () => {
    const service = createMemoryActionsCache(["pnpm-linux-old", "pnpm-linux-new", "cas-main-1"]);
    const { ports: p, fs, rec } = createTestPorts({ exec: fakeExec, actionsCache: service });
    const graph = newGraph();
    const pnpm = restoreCache(graph, {
      name: "restore:pnpm",
      path: ["~/.pnpm-store"],
      key: "pnpm-linux-fresh",
      restoreKeys: ["pnpm-linux-"],
    });
    const cas = restoreCache(graph, { name: "restore:cas", path: [".cas"], key: "cas-main-1" });
    const broken = restoreCache(graph, { name: "restore:broken", path: [], key: "broken" });
    const install = addCommand(graph, {
      name: "install",
      cmd: ["ok"],
      deps: { pnpm },
      cacheable: false,
    });
    saveCache(graph, { name: "save:pnpm", cache: pnpm, deps: { install: settled(install) } });
    saveCache(graph, { name: "save:cas", cache: cas, deps: { install } });
    const save = service.saveCache;
    service.saveCache = async (paths, key) => {
      if (key === "broken") throw new Error("Path Validation Error: nothing to save");
      return save(paths, key);
    };
    saveCache(graph, { name: "save:broken", cache: broken });

    const results = await executeUnder(graph, p);
    const byName = new Map(results.map((r) => [r.name, r]));
    const json = async (name: string): Promise<unknown> => {
      const r = byName.get(name);
      assert.ok(r, name);
      return r.status === "done" ? parsed(fs, soleOutput(r.outputs)) : r.status;
    };
    const log = async (name: string) => {
      const r = byName.get(name);
      assert.ok(r, name);
      return fs.readText(`${CAS}.logs/${r.actionKey}.log`);
    };

    assert.deepEqual(
      {
        restored: {
          pnpm: await json("restore:pnpm"),
          cas: await json("restore:cas"),
          broken: await json("restore:broken"),
        },
        saved: {
          pnpm: await json("save:pnpm"),
          cas: await json("save:cas"),
          broken: await json("save:broken"),
        },
        logs: [
          await log("restore:pnpm"),
          await log("restore:broken"),
          await log("save:cas"),
          await log("save:broken"),
        ],
        warnings: rec.annotations,
        entries: [...service.entries],
        manifests: [...fs.files.keys()].filter((f) => f.endsWith("manifest.json")),
        posts: Object.fromEntries(postNodes(graph)),
      },
      {
        restored: { pnpm: "pnpm-linux-new", cas: "cas-main-1", broken: null },
        saved: { pnpm: 4, cas: null, broken: null },
        logs: [
          "Cache restored from key: pnpm-linux-new",
          "Cache not found for input keys: broken",
          "Cache hit occurred on the primary key cas-main-1, not saving cache.",
          "Failed to save: Path Validation Error: nothing to save",
        ],
        warnings: [
          {
            level: "warning",
            title: "save:broken",
            message: "Path Validation Error: nothing to save",
          },
        ],
        entries: [
          ["pnpm-linux-old", []],
          ["pnpm-linux-new", []],
          ["cas-main-1", []],
          ["pnpm-linux-fresh", ["~/.pnpm-store"]],
        ],
        manifests: [],
        posts: {
          "save:pnpm": "restore:pnpm",
          "save:cas": "restore:cas",
          "save:broken": "restore:broken",
        },
      },
    );
  });
});

describe("uploadArtifact", () => {
  test("dep outputs upload from the CAS rooted at their common directory; a taken name needs overwrite; a failed settled dep leaves no files; no service uploads nothing; the client's response is the output", async () => {
    const {
      ports: p,
      fs,
      rec,
      actionsArtifact: service,
    } = createTestPorts({
      exec: {
        run: async ([program, path]) => {
          if (program === "pack" && path) await fs.writeText(path, "bytes");
          if (program === "bundle" && path) await fs.writeText(path, "js");
          return program === "bad"
            ? { code: 1, stdout: "", stderr: "", output: "", ok: false }
            : { code: 0, stdout: "", stderr: "", output: "", ok: true };
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
      options: { retentionDays: 7 },
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
    uploadArtifact(graph, {
      name: "upload:both",
      artifact: "both",
      path: ({ pack, bundle }) => [pack.tarball, bundle.main],
      deps: { pack, bundle, again },
    });
    uploadArtifact(graph, {
      name: "upload:report",
      artifact: "report",
      path: ({ bad }) => [bad.report],
      deps: { bad: settled(bad) },
    });
    uploadArtifact(graph, {
      name: "upload:required",
      artifact: "required",
      path: ({ bad }) => [bad.report],
      deps: { bad: settled(bad) },
      ifNoFilesFound: "error",
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
      { ...p, actionsArtifact: nullActionsArtifact },
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
        ? parsed(fs, soleOutput(r.outputs))
        : r.status === "failed" && r.error.message;
    };
    const tarballUpload = byName.get("upload:tarball");
    assert.ok(tarballUpload, "upload:tarball");
    const names = [
      "upload:tarball",
      "upload:again",
      "upload:overwrite",
      "upload:both",
      "upload:report",
      "upload:required",
      "upload:offline",
    ];
    assert.deepEqual(
      {
        outputs: Object.fromEntries(
          await Promise.all(names.map(async (n): Promise<[string, unknown]> => [n, await json(n)])),
        ),
        log: await fs.readText(logPath(CAS, tarballUpload.actionKey)),
        warnings: rec.annotations,
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
          "upload:report": {},
          "upload:required":
            "No files were found with the provided path: bad.report. No artifacts will be uploaded.",
          "upload:offline": {},
        },
        log: "Artifact tarball has been successfully uploaded! Final size is 1 bytes. Artifact ID is 1",
        warnings: [
          {
            level: "warning",
            title: "upload:report",
            message:
              "No files were found with the provided path: bad.report. No artifacts will be uploaded.",
          },
        ],
        uploads: [
          ["tarball", { files: [`${out("pack")}/pkg.tgz`], rootDirectory: out("pack") }],
          [
            "both",
            { files: [`${out("pack")}/pkg.tgz`, `${out("bundle")}/main.js`], rootDirectory: CAS },
          ],
        ],
        // Commands that declare no inputs run every time too.
        uncached: ["pack", "bundle", "bad", ...names.slice(0, -1), "pack", "upload:offline"],
      },
    );
  });
});
