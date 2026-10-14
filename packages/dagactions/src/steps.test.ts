import { execute, Graph, MemCache, optional } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Sh } from "./ports.ts";
import { nullActionsArtifact } from "./ports/actions-artifact.ts";
import { createMemoryActionsCache } from "./ports/actions-cache.ts";
import { createTestPorts } from "./ports/memory.ts";
import {
  gate,
  post,
  postNodes,
  restoreCache,
  run,
  runAll,
  saveCache,
  uploadArtifact,
} from "./steps.ts";

const CAS = "/cas";

const ERR = Array.from({ length: 30 }, (_, i) => `err ${i + 1}`).join("\n") + "\n";
/** A shell whose only commands are `ok` (exit 0) and `bad` (exit 1 with a long stderr). */
const fakeSh: Sh = {
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

describe("runAll + gate", () => {
  test("the result is the output, the logs sit beside it, a non-zero exit fails, and the gate reports what failed", async () => {
    const { ports: p } = createTestPorts({ sh: fakeSh });
    const graph = new Graph();
    const checks = runAll(graph, p, { good: { cmd: ["ok"] }, bad: { cmd: ["bad", "--flag"] } });
    gate(graph, p, { deps: checks });

    const results = await execute(graph, { cache: new MemCache(), fs: p.fs, casBaseDir: CAS });
    const byName = new Map(results.map((r) => [r.name, r]));
    const goodResult = byName.get("good")!;
    const badResult = byName.get("bad")!;
    const gateResult = byName.get("gate")!;
    const goodKey = goodResult.actionKey;

    assert.deepEqual(
      {
        good: goodResult.status === "done" && {
          outputs: goodResult.outputs,
          log: await p.fs.readText(`${CAS}/${goodKey}/out/output.log`),
          result: JSON.parse(await p.fs.readText(`${CAS}/${goodKey}/out/result.json`)),
        },
        bad: badResult.status === "fail" && badResult.error.message,
        gate: gateResult.status === "fail" && gateResult.error.message,
      },
      {
        good: {
          outputs: { result: `${CAS}/${goodKey}/out/result.json` },
          log: "hello\n",
          result: { cmd: ["ok"], cwd: "", code: 0 },
        },
        bad: "bad --flag exited 1",
        gate: "failed: bad",
      },
    );
  });
});

describe("restoreCache + saveCache", () => {
  test("a restore-key match restores the newest prefix match and saves the primary key; an exact hit saves nothing; a refused save warns; the outputs are what the toolkit returned", async () => {
    const service = createMemoryActionsCache(["pnpm-linux-old", "pnpm-linux-new", "cas-main-1"]);
    const { ports: p, fs, rec } = createTestPorts({ sh: fakeSh, actionsCache: service });
    const graph = new Graph();
    const pnpm = restoreCache(graph, p, {
      name: "restore:pnpm",
      path: ["~/.pnpm-store"],
      key: "pnpm-linux-fresh",
      restoreKeys: ["pnpm-linux-"],
    });
    const cas = restoreCache(graph, p, { name: "restore:cas", path: [".cas"], key: "cas-main-1" });
    const broken = restoreCache(graph, p, { name: "restore:broken", path: [], key: "broken" });
    const install = run(graph, p, {
      name: "install",
      cmd: ["ok"],
      deps: { pnpm },
      cacheable: false,
    });
    saveCache(graph, p, { name: "save:pnpm", cache: pnpm, deps: { install: optional(install) } });
    saveCache(graph, p, { name: "save:cas", cache: cas, deps: { install } });
    const save = service.saveCache;
    service.saveCache = async (paths, key) => {
      if (key === "broken") throw new Error("Path Validation Error: nothing to save");
      return save(paths, key);
    };
    saveCache(graph, p, { name: "save:broken", cache: broken, deps: {} });

    const results = await execute(graph, { cache: new MemCache(), fs: p.fs, casBaseDir: CAS });
    const byName = new Map(results.map((r) => [r.name, r]));
    const json = async (name: string) => {
      const r = byName.get(name)!;
      return r.status === "done" ? JSON.parse(await fs.readText(r.outputs as string)) : r.status;
    };
    const log = async (name: string) =>
      fs.readText(`${CAS}/${byName.get(name)!.actionKey}/out/output.log`);

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
      },
    );
  });
});

describe("uploadArtifact", () => {
  test("dep outputs upload from the CAS rooted at their common directory; a taken name needs overwrite; a failed optional dep leaves no files; no service uploads nothing; the client's response is the output", async () => {
    const {
      ports: p,
      fs,
      rec,
      actionsArtifact: service,
    } = createTestPorts({
      sh: {
        run: async (cmd, opts) => {
          const out = opts!.env!["DAGACTIONS_OUT"]!;
          if (cmd[0] === "pack") await fs.writeText(`${out}/pkg.tgz`, "bytes");
          if (cmd[0] === "bundle") await fs.writeText(`${out}/main.js`, "js");
          return cmd[0] === "bad"
            ? { code: 1, stdout: "", stderr: "", output: "", ok: false }
            : { code: 0, stdout: "", stderr: "", output: "", ok: true };
        },
      },
    });
    const graph = new Graph();
    const pack = run(graph, p, { name: "pack", cmd: ["pack"], outputs: { tarball: "pkg.tgz" } });
    const bundle = run(graph, p, { name: "bundle", cmd: ["bundle"], outputs: { main: "main.js" } });
    const bad = run(graph, p, { name: "bad", cmd: ["bad"], outputs: { report: "report.xml" } });
    const first = uploadArtifact(graph, p, {
      name: "upload:tarball",
      artifact: "tarball",
      path: [pack.outputs.tarball],
      deps: { pack },
      options: { retentionDays: 7 },
    });
    uploadArtifact(graph, p, {
      name: "upload:again",
      artifact: "tarball",
      path: [pack.outputs.tarball],
      deps: { pack, first },
    });
    const again = uploadArtifact(graph, p, {
      name: "upload:overwrite",
      artifact: "tarball",
      path: [pack.outputs.tarball],
      deps: { pack, first },
      overwrite: true,
    });
    uploadArtifact(graph, p, {
      name: "upload:both",
      artifact: "both",
      path: [pack.outputs.tarball, bundle.outputs.main],
      deps: { pack, bundle, again },
    });
    uploadArtifact(graph, p, {
      name: "upload:report",
      artifact: "report",
      path: [bad.outputs.report],
      deps: { bad: optional(bad) },
    });
    uploadArtifact(graph, p, {
      name: "upload:required",
      artifact: "required",
      path: [bad.outputs.report],
      deps: { bad: optional(bad) },
      ifNoFilesFound: "error",
    });
    uploadArtifact(
      graph,
      { ...p, actionsArtifact: nullActionsArtifact },
      {
        name: "upload:offline",
        artifact: "offline",
        path: [pack.outputs.tarball],
        deps: { pack },
      },
    );
    assert.throws(
      () =>
        uploadArtifact(graph, p, { name: "orphan", artifact: "x", path: [pack.outputs.tarball] }),
      { message: "orphan uses pack.outputs.tarball, but pack is not in its deps" },
    );

    const results = await execute(graph, { cache: new MemCache(), fs: p.fs, casBaseDir: CAS });
    const byName = new Map(results.map((r) => [r.name, r]));
    const out = (name: string) => `${CAS}/${byName.get(name)!.actionKey}/out`;
    const json = async (name: string) => {
      const r = byName.get(name)!;
      return r.status === "done"
        ? JSON.parse(await fs.readText(r.outputs as string))
        : r.status === "fail" && r.error.message;
    };
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
        outputs: Object.fromEntries(await Promise.all(names.map(async (n) => [n, await json(n)]))),
        log: await fs.readText(`${out("upload:tarball")}/output.log`),
        warnings: rec.annotations,
        uploads: [...service.uploads],
        config: JSON.parse(graph.describe().find((n) => n.name === "upload:tarball")!.config),
        uncached: graph
          .describe()
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
        config: {
          v: 1,
          artifact: "tarball",
          path: [{ node: "pack", output: "tarball" }],
          ifNoFilesFound: "warn",
          options: { retentionDays: 7 },
        },
        uncached: names,
      },
    );
  });
});

describe("declared outputs", () => {
  test("a declared file under $DAGACTIONS_OUT is an output, a consumer names it as outputs.<key> in an argument or env, a dep it did not declare is refused, and a missing file fails", async () => {
    const seen: Array<{ cmd: string[]; env: Record<string, string> | undefined }> = [];
    const { ports: p, fs } = createTestPorts({
      sh: {
        run: async (cmd, opts) => {
          seen.push({ cmd, env: opts?.env });
          if (cmd[0] === "pack")
            await fs.writeText(`${opts!.env!["DAGACTIONS_OUT"]}/pkg.tgz`, "bytes");
          return { code: 0, stdout: "", stderr: "", output: "", ok: true };
        },
      },
    });
    const graph = new Graph();
    const pack = run(graph, p, { name: "pack", cmd: ["pack"], outputs: { tarball: "pkg.tgz" } });
    run(graph, p, {
      name: "publish",
      cmd: ["publish", pack.outputs.tarball],
      env: { RESULT: pack.outputs.result },
      deps: { pack },
    });
    run(graph, p, { name: "forgot", cmd: ["ok"], outputs: { tarball: "pkg.tgz" } });
    assert.throws(() => run(graph, p, { name: "orphan", cmd: ["publish", pack.outputs.tarball] }), {
      message: "orphan uses pack.outputs.tarball, but pack is not in its deps",
    });
    const results = await execute(graph, { cache: new MemCache(), fs: p.fs, casBaseDir: CAS });
    const byName = new Map(results.map((r) => [r.name, r]));
    const packResult = byName.get("pack")!;
    const forgotResult = byName.get("forgot")!;
    const packKey = packResult.actionKey;
    const tarball = `${CAS}/${packKey}/out/pkg.tgz`;
    const publish = seen.find((s) => s.cmd[0] === "publish")!;
    assert.deepEqual(
      {
        packOutputs: packResult.status === "done" && packResult.outputs,
        publishCmd: publish.cmd,
        publishEnv: publish.env,
        forgot: forgotResult.status === "fail" && forgotResult.error.message,
      },
      {
        packOutputs: { result: `${CAS}/${packKey}/out/result.json`, tarball },
        publishCmd: ["publish", tarball],
        publishEnv: {
          RESULT: `${CAS}/${packKey}/out/result.json`,
          DAGACTIONS_OUT: `${CAS}/${byName.get("publish")!.actionKey}/out`,
        },
        forgot: "declared output tarball missing: pkg.tgz",
      },
    );
  });
});

describe("post", () => {
  test("a post runs after its deps even when they failed, not when its main failed, reads its main's outputs, and sees a failed optional dep's output as empty", async () => {
    const calls: string[][] = [];
    let testsResult: string | undefined;
    const { ports: p, fs } = createTestPorts();
    const sh: Sh = {
      run: async (cmd, opts) => {
        calls.push(cmd);
        if (cmd[1] === "stop") testsResult = opts?.env?.TESTS;
        if (cmd[0] === "bad")
          return { code: 1, stdout: "", stderr: "no\n", output: "no\n", ok: false };
        if (cmd[1] === "start") await fs.writeText(`${opts!.env!.DAGACTIONS_OUT}/pid`, "42");
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      },
    };
    p.sh = sh;
    const graph = new Graph();
    const db = run(graph, p, { name: "up:db", cmd: ["db", "start"], outputs: { pid: "pid" } });
    const broken = run(graph, p, { name: "up:broken", cmd: ["bad"] });
    const tests = run(graph, p, { name: "tests", cmd: ["bad"], deps: { db } });
    post(graph, p, {
      name: "down:db",
      main: db,
      cmd: ["db", "stop", db.outputs.pid],
      env: { TESTS: tests.outputs.result },
      deps: { tests: optional(tests) },
    });
    post(graph, p, { name: "down:broken", main: broken, cmd: ["never"], deps: {} });

    const results = await execute(graph, { cache: new MemCache(), fs: p.fs, casBaseDir: CAS });
    const stop = calls.find((c) => c[1] === "stop")!;
    assert.deepEqual(
      {
        statuses: Object.fromEntries(results.map((r) => [r.name, r.status])),
        calls: calls.map((c) => c.slice(0, 2)),
        stoppedPid: await fs.readText(stop[2]!),
        testsResult,
        uncached: graph
          .describe()
          .filter((n) => n.cacheable === false)
          .map((n) => n.name),
        posts: postNodes(graph).sort(),
      },
      {
        statuses: {
          "up:db": "done",
          "up:broken": "fail",
          tests: "fail",
          "down:db": "done",
          "down:broken": "dep-failed",
        },
        calls: [["db", "start"], ["bad"], ["bad"], ["db", "stop"]],
        stoppedPid: "42",
        testsResult: "",
        uncached: ["down:db", "down:broken"],
        posts: ["down:broken", "down:db"],
      },
    );
  });
});
