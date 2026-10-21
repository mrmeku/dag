import { execute, Graph, MemCache, settled, soleOutput } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { errorMessage } from "./kernel/format.ts";
import type { Exec, Ports } from "./ports.ts";
import { nullActionsArtifact } from "./ports/actions-artifact.ts";
import { createMemoryActionsCache } from "./ports/actions-cache.ts";
import { createTestPorts } from "./ports/memory.ts";
import {
  logPath,
  post,
  postNodes,
  requireAll,
  restoreCache,
  run,
  runAll,
  saveCache,
  uploadArtifact,
  type OutputRef,
} from "./steps.ts";

const CAS = "/cas";
const newGraph = () => new Graph<Ports>();

/** The output directory a run step hands its command. */
const outDirOf = (opts: Parameters<Exec["run"]>[1]): string => {
  const out = opts?.env?.["DAG_OUT"];
  assert.ok(out, "DAG_OUT");
  return out;
};
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

describe("runAll + requireAll", () => {
  test("the result is the output, the logs sit beside it, a non-zero exit fails, and require-all reports what failed", async () => {
    const { ports: p } = createTestPorts({ exec: fakeExec });
    const graph = newGraph();
    const checks = runAll(graph, { good: { cmd: ["ok"] }, bad: { cmd: ["bad", "--flag"] } });
    requireAll(graph, { deps: checks });

    const results = await executeUnder(graph, p);
    const byName = new Map(results.map((r) => [r.name, r]));
    const goodResult = byName.get("good");
    const badResult = byName.get("bad");
    const requireAllResult = byName.get("require-all");
    assert.ok(goodResult && badResult && requireAllResult, "good, bad and require-all");
    const goodKey = goodResult.actionKey;

    const out = goodResult.status === "done" && `${CAS}/${goodKey}/out-${goodResult.contentHash}`;

    assert.deepEqual(
      {
        good: goodResult.status === "done" && {
          outputs: goodResult.outputs,
          log: await p.fs.readText(`${CAS}.logs/${goodKey}.log`),
          result: await parsed(p.fs, `${out}/result.json`),
        },
        bad: badResult.status === "failed" && badResult.error.message,
        requireAll: requireAllResult.status === "failed" && requireAllResult.error.message,
      },
      {
        good: {
          outputs: { result: `${out}/result.json` },
          log: "hello\n",
          result: { cmd: ["ok"], cwd: "", code: 0 },
        },
        bad: "bad --flag exited 1",
        requireAll: "failed: bad",
      },
    );
  });
});

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
    const install = run(graph, {
      name: "install",
      cmd: ["ok"],
      deps: { pnpm },
      cacheable: false,
    });
    saveCache(graph, {
      name: "save:pnpm",
      cache: pnpm,
      deps: { install: settled({ name: install.name }) },
    });
    saveCache(graph, { name: "save:cas", cache: cas, deps: { install } });
    const save = service.saveCache;
    service.saveCache = async (paths, key) => {
      if (key === "broken") throw new Error("Path Validation Error: nothing to save");
      return save(paths, key);
    };
    saveCache(graph, { name: "save:broken", cache: broken, deps: {} });

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
        run: async (cmd, opts) => {
          const out = outDirOf(opts);
          if (cmd[0] === "pack") await fs.writeText(`${out}/pkg.tgz`, "bytes");
          if (cmd[0] === "bundle") await fs.writeText(`${out}/main.js`, "js");
          return cmd[0] === "bad"
            ? { code: 1, stdout: "", stderr: "", output: "", ok: false }
            : { code: 0, stdout: "", stderr: "", output: "", ok: true };
        },
      },
    });
    const graph = newGraph();
    const pack = run(graph, { name: "pack", cmd: ["pack"], outputs: { tarball: "pkg.tgz" } });
    const bundle = run(graph, { name: "bundle", cmd: ["bundle"], outputs: { main: "main.js" } });
    const bad = run(graph, { name: "bad", cmd: ["bad"], outputs: { report: "report.xml" } });
    const first = uploadArtifact(graph, {
      name: "upload:tarball",
      artifact: "tarball",
      path: [pack.outputs.tarball],
      deps: { pack },
      options: { retentionDays: 7 },
    });
    uploadArtifact(graph, {
      name: "upload:again",
      artifact: "tarball",
      path: [pack.outputs.tarball],
      deps: { pack, first },
    });
    const again = uploadArtifact(graph, {
      name: "upload:overwrite",
      artifact: "tarball",
      path: [pack.outputs.tarball],
      deps: { pack, first },
      overwrite: true,
    });
    uploadArtifact(graph, {
      name: "upload:both",
      artifact: "both",
      path: [pack.outputs.tarball, bundle.outputs.main],
      deps: { pack, bundle, again },
    });
    uploadArtifact(graph, {
      name: "upload:report",
      artifact: "report",
      path: [bad.outputs.report],
      deps: { bad: settled({ name: bad.name }) },
    });
    uploadArtifact(graph, {
      name: "upload:required",
      artifact: "required",
      path: [bad.outputs.report],
      deps: { bad: settled({ name: bad.name }) },
      ifNoFilesFound: "error",
    });
    // Ports are the execution's: the upload with no service runs in an execution of its own.
    const offline = newGraph();
    uploadArtifact(offline, {
      name: "upload:offline",
      artifact: "offline",
      path: [pack.outputs.tarball],
      deps: {
        pack: run(offline, { name: "pack", cmd: ["pack"], outputs: { tarball: "pkg.tgz" } }),
      },
    });
    assert.throws(
      () => uploadArtifact(graph, { name: "orphan", artifact: "x", path: [pack.outputs.tarball] }),
      { message: "orphan uses pack.outputs.tarball, but pack is not in its deps" },
    );

    const cache = new MemCache();
    const results = await executeUnder(graph, p, CAS, cache);
    const offlineResults = await executeUnder(
      offline,
      { ...p, actionsArtifact: nullActionsArtifact },
      CAS,
      cache,
    );
    // The offline graph's pack is a cache hit of the first's, which keeps its own result here.
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
            "No files were found with the provided path: bad.outputs.report. No artifacts will be uploaded.",
          "upload:offline": {},
        },
        log: "Artifact tarball has been successfully uploaded! Final size is 1 bytes. Artifact ID is 1",
        warnings: [
          {
            level: "warning",
            title: "upload:report",
            message:
              "No files were found with the provided path: bad.outputs.report. No artifacts will be uploaded.",
          },
        ],
        uploads: [
          ["tarball", { files: [`${out("pack")}/pkg.tgz`], rootDirectory: out("pack") }],
          [
            "both",
            { files: [`${out("pack")}/pkg.tgz`, `${out("bundle")}/main.js`], rootDirectory: CAS },
          ],
        ],
        uncached: names,
      },
    );
  });
});

describe("declared outputs", () => {
  test("a declared file under $DAG_OUT is an output, a consumer names it as outputs.<key> in an argument or env, a dep it did not declare is refused, and a missing file fails", async () => {
    const seen: Array<{ cmd: string[]; env: Record<string, string | undefined> | undefined }> = [];
    const { ports: p, fs } = createTestPorts({
      exec: {
        run: async (cmd, opts) => {
          seen.push({ cmd, env: opts?.env });
          if (cmd[0] === "pack") await fs.writeText(`${outDirOf(opts)}/pkg.tgz`, "bytes");
          return { code: 0, stdout: "", stderr: "", output: "", ok: true };
        },
      },
    });
    const graph = newGraph();
    const pack = run(graph, { name: "pack", cmd: ["pack"], outputs: { tarball: "pkg.tgz" } });
    run(graph, {
      name: "publish",
      cmd: ["publish", pack.outputs.tarball],
      env: { RESULT: pack.outputs.result },
      deps: { pack },
    });
    run(graph, { name: "forgot", cmd: ["ok"], outputs: { tarball: "pkg.tgz" } });
    assert.throws(() => run(graph, { name: "orphan", cmd: ["publish", pack.outputs.tarball] }), {
      message: "orphan uses pack.outputs.tarball, but pack is not in its deps",
    });
    const results = await executeUnder(graph, p);
    const byName = new Map(results.map((r) => [r.name, r]));
    const packResult = byName.get("pack");
    const forgotResult = byName.get("forgot");
    const publishResult = byName.get("publish");
    assert.ok(packResult && forgotResult && publishResult, "pack, forgot and publish");
    const packOut =
      packResult.status === "done" &&
      `${CAS}/${packResult.actionKey}/out-${packResult.contentHash}`;
    const tarball = `${packOut}/pkg.tgz`;
    const publish = seen.find((s) => s.cmd[0] === "publish");
    assert.ok(publish, "publish command");
    assert.deepEqual(
      {
        packOutputs: packResult.status === "done" && packResult.outputs,
        publishCmd: publish.cmd,
        publishEnv: {
          ...publish.env,
          DAG_OUT: publish.env?.DAG_OUT?.replace(/[0-9a-f-]{36}$/, "<uuid>"),
        },
        forgot: forgotResult.status === "failed" && forgotResult.error.message,
      },
      {
        packOutputs: { result: `${packOut}/result.json`, tarball },
        publishCmd: ["publish", tarball],
        publishEnv: {
          RESULT: `${packOut}/result.json`,
          DAG_OUT: `${CAS}/${publishResult.actionKey}/tmp-<uuid>`,
        },
        forgot: "declared output tarball missing: pkg.tgz",
      },
    );
  });
});

describe("refs in template strings", () => {
  test("a ref inside a template string resolves to its path in cmd, env and an artifact path, and fails the step for a failed settled dep, which a whole ref resolves to nothing; one outside deps is refused at graph build; the key holds names, never paths", async () => {
    const seen: Array<{ cmd: string[]; map: string | undefined }> = [];
    const {
      ports: p,
      fs,
      actionsArtifact: service,
    } = createTestPorts({
      exec: {
        run: async (cmd, opts) => {
          seen.push({ cmd, map: opts?.env?.MAP });
          const out = outDirOf(opts);
          if (cmd[0] === "build") {
            await fs.writeText(`${out}/main.js`, "js");
            await fs.writeText(`${out}/main.js.map`, "map");
          }
          const ok = cmd[0] !== "bad";
          return { code: ok ? 0 : 1, stdout: "", stderr: "", output: "", ok };
        },
      },
    });
    const graph = newGraph();
    const built = run(graph, { name: "build", cmd: ["build"], outputs: { bundle: "main.js" } });
    const bad = run(graph, { name: "bad", cmd: ["bad"] });
    run(graph, {
      name: "size",
      cmd: ["size", `--file=${built.outputs.bundle}`, bad.outputs.result],
      env: { MAP: `${built.outputs.bundle}.map` },
      deps: { built, bad: settled({ name: bad.name }) },
    });
    run(graph, {
      name: "report",
      cmd: ["report", `--from=${bad.outputs.result}`],
      deps: { bad: settled({ name: bad.name }) },
    });
    uploadArtifact(graph, {
      name: "upload:map",
      artifact: "map",
      path: [`${built.outputs.bundle}.map`, bad.outputs.result],
      deps: { built, bad: settled({ name: bad.name }) },
    });
    uploadArtifact(graph, {
      name: "upload:xml",
      artifact: "xml",
      path: [`${bad.outputs.result}.xml`],
      deps: { bad: settled({ name: bad.name }) },
    });
    const refused = [
      () => run(graph, { name: "orphan", cmd: [`--file=${built.outputs.bundle}`] }),
      () => run(graph, { name: "orphan", cmd: ["x"], env: { F: `${built.outputs.bundle}` } }),
      () =>
        uploadArtifact(graph, {
          name: "orphan",
          artifact: "x",
          path: [`${built.outputs.bundle}.map`],
        }),
    ].map((add) => {
      try {
        add();
        return null;
      } catch (e) {
        return errorMessage(e);
      }
    });
    const results = await executeUnder(graph, p);
    // The same graph under another CAS directory, where every output has another path.
    const elsewhere = await executeUnder(graph, p, "/elsewhere");
    const keyOf = (rs: typeof results) => {
      const size = rs.find((r) => r.name === "size");
      assert.ok(size, "size");
      return size.actionKey;
    };
    const build = results.find((r) => r.name === "build");
    assert.ok(build, "build");
    const out = build.status === "done" && `${CAS}/${build.actionKey}/out-${build.contentHash}`;
    assert.deepEqual(
      {
        size: seen.find((s) => s.cmd[0] === "size"),
        failed: results
          .flatMap((r) => (r.status === "failed" ? [[r.name, r.error.message]] : []))
          .sort(),
        uploads: [...service.uploads],
        refused,
        keyHoldsNoPath: keyOf(elsewhere) === keyOf(results),
      },
      {
        size: { cmd: ["size", `--file=${out}/main.js`, ""], map: `${out}/main.js.map` },
        failed: [
          ["bad", "bad exited 1"],
          ["report", '"--from=bad.outputs.result" has no path: bad, a settled dep, failed'],
          ["upload:xml", '"bad.outputs.result.xml" has no path: bad, a settled dep, failed'],
        ],
        uploads: [["map", { files: [`${out}/main.js.map`], rootDirectory: out }]],
        refused: Array(3).fill("orphan uses build.outputs.bundle, but build is not in its deps"),
        keyHoldsNoPath: true,
      },
    );
  });
});

describe("a dep's output in a command", () => {
  test("is keyed by the role it points through and the output's name, so renaming the dep runs neither the step nor its dependents again", async () => {
    const { ports: p, fs } = createTestPorts({
      exec: {
        run: async (cmd, opts) => {
          if (cmd[0] === "pack") await fs.writeText(`${outDirOf(opts)}/pkg.tgz`, "bytes");
          return { code: 0, stdout: "", stderr: "", output: "", ok: true };
        },
      },
    });
    const cache = new MemCache();
    const statuses = async (packName: string) => {
      const graph = newGraph();
      const pack = run(graph, { name: packName, cmd: ["pack"], outputs: { tarball: "pkg.tgz" } });
      const publish = run(graph, {
        name: "publish",
        cmd: ["publish", pack.outputs.tarball, `--file=${pack.outputs.tarball}`],
        env: { TARBALL: pack.outputs.tarball },
        deps: { pack },
      });
      requireAll(graph, { deps: { publish } });
      const results = await executeUnder(graph, p, CAS, cache);
      return Object.fromEntries(results.map((r) => [r.name, r.status]));
    };
    assert.deepEqual(
      { first: await statuses("pack"), renamed: await statuses("pack:renamed") },
      {
        first: { pack: "done", publish: "done", "require-all": "done" },
        renamed: { "pack:renamed": "cached", publish: "cached", "require-all": "cached" },
      },
    );
  });
});

describe("refs built by hand", () => {
  test("a plain { node, output } resolves in cmd, env and an artifact path as one from outputs does, and one outside deps is refused, whole or in a template string", async () => {
    const seen: Array<{ cmd: string[]; f: string | undefined }> = [];
    const {
      ports: p,
      fs,
      actionsArtifact: service,
    } = createTestPorts({
      exec: {
        run: async (cmd, opts) => {
          seen.push({ cmd, f: opts?.env?.F });
          if (cmd[0] === "build") await fs.writeText(`${outDirOf(opts)}/main.js`, "js");
          return { code: 0, stdout: "", stderr: "", output: "", ok: true };
        },
      },
    });
    const graph = newGraph();
    const built = run(graph, { name: "build", cmd: ["build"], outputs: { bundle: "main.js" } });
    const bundle: OutputRef = { node: "build", output: "bundle" };
    run(graph, { name: "size", cmd: ["size", bundle], env: { F: bundle }, deps: { built } });
    uploadArtifact(graph, { name: "upload", artifact: "js", path: [bundle], deps: { built } });
    const elsewhere: OutputRef = { node: "elsewhere", output: "bundle" };
    const refused = [
      () => run(graph, { name: "orphan", cmd: ["echo", elsewhere] }),
      () => run(graph, { name: "templated", cmd: [`--file=${bundle}`], deps: { built } }),
    ].map((add) => {
      try {
        add();
        return null;
      } catch (e) {
        return errorMessage(e);
      }
    });
    const results = await executeUnder(graph, p);
    const build = results.find((r) => r.name === "build");
    assert.ok(build, "build");
    const out = build.status === "done" && `${CAS}/${build.actionKey}/out-${build.contentHash}`;
    assert.deepEqual(
      { size: seen.find((s) => s.cmd[0] === "size"), uploads: [...service.uploads], refused },
      {
        size: { cmd: ["size", `${out}/main.js`], f: `${out}/main.js` },
        uploads: [["js", { files: [`${out}/main.js`], rootDirectory: out }]],
        refused: [
          "orphan uses elsewhere.outputs.bundle, but elsewhere is not in its deps",
          "templated: an object in a template string; a ref there must come from a step's outputs",
        ],
      },
    );
  });
});

describe("post", () => {
  test("a post runs after its deps even when they failed, not when its main failed, reads its main's outputs, and sees a failed settled dep's output as empty", async () => {
    const calls: string[][] = [];
    let testsResult: string | undefined;
    const { ports: p, fs } = createTestPorts();
    const exec: Exec = {
      run: async (cmd, opts) => {
        calls.push(cmd);
        if (cmd[1] === "stop") testsResult = opts?.env?.TESTS;
        if (cmd[0] === "bad")
          return { code: 1, stdout: "", stderr: "no\n", output: "no\n", ok: false };
        if (cmd[1] === "start") await fs.writeText(`${outDirOf(opts)}/pid`, "42");
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    p.exec = exec;
    const graph = newGraph();
    const db = run(graph, { name: "up:db", cmd: ["db", "start"], outputs: { pid: "pid" } });
    const broken = run(graph, { name: "up:broken", cmd: ["bad"] });
    const tests = run(graph, { name: "tests", cmd: ["bad"], deps: { db } });
    post(graph, {
      name: "down:db",
      main: db,
      cmd: ["db", "stop", db.outputs.pid],
      env: { TESTS: tests.outputs.result },
      deps: { tests: settled({ name: tests.name }) },
    });
    post(graph, { name: "down:broken", main: broken, cmd: ["never"], deps: {} });

    const results = await executeUnder(graph, p);
    const stopPid = calls.find((c) => c[1] === "stop")?.[2];
    assert.ok(stopPid, "the stop command's pid path");
    assert.deepEqual(
      {
        statuses: Object.fromEntries(results.map((r) => [r.name, r.status])),
        calls: calls.map((c) => c.slice(0, 2)),
        stoppedPid: await fs.readText(stopPid),
        testsResult,
        uncached: graph
          .describe()
          .filter((n) => n.cacheable === false)
          .map((n) => n.name),
        posts: Object.fromEntries(postNodes(graph)),
      },
      {
        statuses: {
          "up:db": "done",
          "up:broken": "failed",
          tests: "failed",
          "down:db": "done",
          "down:broken": "dep-failed",
        },
        calls: [["db", "start"], ["bad"], ["bad"], ["db", "stop"]],
        stoppedPid: "42",
        testsResult: "",
        uncached: ["down:db", "down:broken"],
        posts: { "down:db": "up:db", "down:broken": "up:broken" },
      },
    );
  });
});
