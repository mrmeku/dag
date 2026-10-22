import { actionsFor, execute, file, Graph, MemCache, settled, type Result } from "@mrmeku/dagraph";
import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { post, run, runShell } from "./commands.ts";
import { LAST_RUN_FILE } from "./config.ts";
import type { Exec, ExecResult, Ports } from "./ports.ts";
import { createTestPorts } from "./ports/memory.ts";
import { createExec } from "./ports/real.ts";
import { runWorkflow } from "./runner.ts";
import { logPath } from "./step-records.ts";
import { postNodes } from "./steps.ts";

const CAS = "/cas";
const newGraph = () => new Graph<Ports>();
const executeUnder = (
  graph: Graph<Ports>,
  ports: Ports,
  cache = new MemCache(),
  casBaseDir = CAS,
) => execute(graph, { ports, cache, fs: ports.fs, casBaseDir });
const exited = (code: number, output = ""): ExecResult => ({
  code,
  stdout: output,
  stderr: "",
  output,
  ok: code === 0,
});
const byName = (results: Result[]) => new Map(results.map((r) => [r.name, r]));
const statuses = (results: Result[]) => Object.fromEntries(results.map((r) => [r.name, r.status]));
const errorOf = (result: Result | undefined) => result?.status === "failed" && result.error.message;
const refusal = (add: () => unknown) => {
  try {
    add();
    return "accepted";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};
/** `value`, which the test expects to be there: it throws, naming `what`, when it is not. */
const found = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`${what} is missing`);
  return value;
};

describe("a command", () => {
  test("takes a dep's output as its own argument or env value, its path when it starts, and its own out and outputDir; a nonzero exit fails it, and its log sits beside its output", async () => {
    const seen: Array<{ cmd: string[]; env: Record<string, string | undefined> | undefined }> = [];
    const { ports, fs } = createTestPorts({
      exec: {
        run: async (cmd, opts) => {
          seen.push({ cmd, env: opts?.env });
          const [program, path] = cmd;
          if (program === "pack" && path) await fs.writeText(path, "bytes");
          return program === "bad" ? exited(1, "err\n") : exited(0, "hello\n");
        },
      },
    });
    const graph = newGraph();
    const pack = run(graph, {
      name: "pack",
      cmd: ({ out }) => ["pack", out.tarball],
      outputs: { tarball: "pkg.tgz" },
    });
    run(graph, {
      name: "publish",
      deps: { pack },
      cmd: ({ pack }) => ["publish", pack.tarball],
      env: ({ pack, outputDir }) => ({ TARBALL: pack.tarball, OUT: outputDir, MODE: "dry" }),
    });
    run(graph, { name: "bad", cmd: ["bad", "--flag"] });
    const results = byName(await executeUnder(graph, ports));
    const packed = found(results.get("pack"), "pack's result");
    const publishKey = found(results.get("publish"), "publish's result").actionKey;
    const tarball =
      packed.status === "done" && `${CAS}/${packed.actionKey}/out-${packed.contentHash}/pkg.tgz`;
    const publish = found(
      seen.find((s) => s.cmd[0] === "publish"),
      "the publish command",
    );
    assert.deepEqual(
      {
        packOutputs: packed.status === "done" && packed.outputs,
        publish: {
          ...publish,
          env: { ...publish.env, OUT: publish.env?.OUT?.replace(/[0-9a-f-]{36}$/, "<uuid>") },
        },
        publishLog: await fs.readText(logPath(CAS, publishKey)),
        bad: errorOf(results.get("bad")),
      },
      {
        packOutputs: { tarball },
        publish: {
          cmd: ["publish", tarball],
          env: {
            TARBALL: tarball,
            OUT: `${CAS}/${publishKey}/tmp-<uuid>`,
            MODE: "dry",
          },
        },
        publishLog: "hello\n",
        bad: "bad --flag exited 1",
      },
    );
  });

  test("keys a dep's output by the role it points through and the output's name: renaming the dep's node runs neither it nor its dependents again, and another role does", async () => {
    const { ports, fs } = createTestPorts({
      exec: {
        run: async ([program, path]) => {
          if (program === "pack" && path) await fs.writeText(path, "bytes");
          return exited(0);
        },
      },
    });
    const cache = new MemCache();
    const statusesOf = async (packName: string, role: string, casBaseDir = CAS, at = cache) => {
      const graph = newGraph();
      const pack = run(graph, {
        name: packName,
        cmd: ({ out }) => ["pack", out.tarball],
        outputs: { tarball: "pkg.tgz" },
        cacheable: true,
      });
      run(graph, {
        name: "publish",
        deps: { [role]: pack },
        cmd: (refs) => ["publish", found(refs[role], role).tarball],
        env: (refs) => ({ TARBALL: found(refs[role], role).tarball }),
        cacheable: true,
      });
      const results = await executeUnder(graph, ports, at, casBaseDir);
      return {
        ...statuses(results),
        key: found(byName(results).get("publish"), "publish").actionKey,
      };
    };
    const first = await statusesOf("pack", "pack");
    const { key, ...firstStatuses } = first;
    // Another CAS directory gives every output another path, which must not change the key.
    const { key: elsewhere } = await statusesOf("pack", "pack", "/elsewhere", new MemCache());
    const { key: _renamedKey, ...renamed } = await statusesOf("pack:renamed", "pack");
    const { key: _otherKey, ...otherRole } = await statusesOf("pack", "tarballs");
    assert.deepEqual(
      { first: firstStatuses, renamed, otherRole, keyHoldsNoPath: elsewhere === key },
      {
        first: { pack: "done", publish: "done" },
        renamed: { "pack:renamed": "cached", publish: "cached" },
        otherRole: { pack: "cached", publish: "done" },
        keyHoldsNoPath: true,
      },
    );
  });

  test("that declares no inputs runs every time, and one that declares inputs is cached on them; its own command does not count, and an explicit cacheable wins", async () => {
    const { ports } = createTestPorts({
      files: { "src/a.ts": "a" },
      exec: { run: async () => exited(0) },
    });
    const cache = new MemCache();
    const src = { "src/a.ts": file("src/a.ts") };
    const once = async () => {
      const graph = newGraph();
      run(graph, { name: "smoke", cmd: ["curl", "-f", "localhost"] });
      run(graph, { name: "lint", cmd: ["lint"], inputs: src });
      // A glob that matched nothing.
      run(graph, { name: "empty", cmd: ["empty"], inputs: {} });
      run(graph, { name: "publish", cmd: ["publish"], cacheable: true });
      run(graph, { name: "e2e", cmd: ["e2e"], inputs: src, cacheable: false });
      return statuses(await executeUnder(graph, ports, cache));
    };
    assert.deepEqual(
      [await once(), await once()],
      [
        { smoke: "done", lint: "done", empty: "done", publish: "done", e2e: "done" },
        { smoke: "done", lint: "cached", empty: "done", publish: "cached", e2e: "done" },
      ],
    );
  });

  test("is refused before anything runs when it puts its own output in a string", () => {
    const graph = newGraph();
    assert.deepEqual(
      {
        ownTemplateString: refusal(() =>
          run(graph, {
            name: "x",
            outputs: { id: "id" },
            // @ts-expect-error its own output in a template string (TS2731)
            cmd: ({ out }) => [`${out.id}.tmp`],
          }),
        ),
        ownInEnv: refusal(() =>
          run(graph, {
            name: "z",
            outputs: { id: "id" },
            cmd: ["write-id"],
            // @ts-expect-error its own output in a template string (TS2731)
            env: ({ out }) => ({ ID: `${out.id}.tmp` }),
          }),
        ),
        ownInShell: refusal(() =>
          runShell(graph, {
            name: "y",
            cmd: 'tar -cf "$OUT" .',
            // @ts-expect-error its own output dir in a template string (TS2731)
            env: ({ outputDir }) => ({ OUT: `${outputDir}/pkg.tar` }),
          }),
        ),
      },
      {
        ownTemplateString:
          'node "x": out.id can\'t be part of a string. Make it its own argument: cmd: ({ out }) => [..., out.id].',
        ownInEnv:
          'node "z": out.id can\'t be part of a string. Make it its own env value: env: ({ out }) => ({ OUT: out.id }).',
        ownInShell:
          'node "y": outputDir can\'t be part of a string. Make it its own env value, read quoted: env: ({ outputDir }) => ({ OUT: outputDir }), then "$OUT".',
      },
    );
  });
});

describe("a command's paths", () => {
  test("a dep's output holding a list of paths reaches a command as those paths joined with :", async () => {
    const seen: string[][] = [];
    const { ports } = createTestPorts({
      exec: { run: async (cmd) => (seen.push(cmd), exited(0)) },
    });
    const graph = newGraph();
    const files = actionsFor<Ports>()({
      kind: "files",
      action: async ({ outputDir, ports }) => {
        const paths = [`${outputDir}/a.txt`, `${outputDir}/b.txt`];
        for (const path of paths) await ports.fs.writeText(path, path);
        return { files: paths };
      },
    });
    const listing = files.addNode(graph, {});
    run(graph, { name: "ls", deps: { listing }, cmd: ({ listing }) => ["ls", listing.files] });
    const results = byName(await executeUnder(graph, ports));
    const listed = found(results.get("files"), "the files node's result");
    const dir = listed.status === "done" && `${CAS}/${listed.actionKey}/out-${listed.contentHash}`;
    assert.deepEqual(seen, [["ls", `${dir}/a.txt:${dir}/b.txt`]]);
  });

  test("refs reach a command as absolute paths when it starts, so one with its own cwd sees the same files under a relative CAS directory; its outputs and its manifest's paths stay relative, and its log and last-run.json sit where the CAS directory names", async () => {
    const root = mkdtempSync(join(tmpdir(), "dag-cwd-"));
    try {
      mkdirSync(join(root, "sub"));
      const fs = createNodeDagFs();
      const { ports } = createTestPorts({ exec: createExec() });
      ports.fs = fs;
      // Relative, as the CLI's .dag/cas is.
      const cas = relative(process.cwd(), join(root, "cas"));
      const sub = relative(process.cwd(), join(root, "sub"));
      const { results } = await runWorkflow({
        ports,
        casBaseDir: cas,
        historyDir: join(root, "history"),
        implementation: async (graph) => {
          const pack = runShell(graph, {
            name: "pack",
            cmd: 'echo bytes > "$OUT"',
            env: ({ out }) => ({ OUT: out.tarball }),
            outputs: { tarball: "t.txt" },
          });
          run(graph, {
            name: "list",
            deps: { pack },
            cwd: sub,
            cmd: ({ pack }) => ["cat", pack.tarball],
          });
          runShell(graph, {
            name: "own",
            cwd: sub,
            // An input makes it cacheable, so it writes a manifest.
            inputs: { version: "own-v1" },
            cmd: 'echo 1 > "$ID"',
            env: ({ out }) => ({ ID: out.id }),
            outputs: { id: "id" },
          });
        },
      });
      const byNode = byName(results);
      const own = found(byNode.get("own"), "own's result");
      const ownDir = own.status === "done" ? `${own.actionKey}/out-${own.contentHash}` : "";
      const listKey = found(byNode.get("list"), "list's result").actionKey;
      const manifest: unknown = JSON.parse(
        await fs.readText(`${cas}/${own.actionKey}/manifest.json`),
      );
      assert.deepEqual(
        {
          statuses: Object.fromEntries([...byNode].map(([name, r]) => [name, r.status])),
          listed: await fs.readText(logPath(cas, listKey)),
          own: {
            outputs: own.status === "done" && own.outputs,
            content: await fs.readText(`${cas}/${ownDir}/id`),
          },
          manifest,
          lastRun: await fs.exists(`${cas}/${LAST_RUN_FILE}`),
        },
        {
          statuses: { pack: "done", list: "done", own: "done" },
          listed: "bytes\n",
          own: { outputs: { id: `${cas}/${ownDir}/id` }, content: "1\n" },
          manifest: {
            outputs: { id: `${cas}/${ownDir}/id` },
            contentHash: own.status === "done" && own.contentHash,
          },
          lastRun: true,
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runShell", () => {
  test("runs its string under bash -eo pipefail, where a settled dep's output is unset when the dep failed, even when inherited; a machine without bash fails the node, saying so, as run does for a program it cannot start", async () => {
    const { ports, fs } = createTestPorts({ exec: createExec() });
    const graph = newGraph();
    const tests = runShell(graph, {
      name: "tests",
      cmd: "exit 3",
      outputs: { report: "junit.xml" },
    });
    runShell(graph, { name: "pipe", cmd: "false | cat; echo after" });
    runShell(graph, {
      name: "report",
      deps: { tests: settled(tests) },
      cmd: 'if [ -n "${DAG_TEST_REPORT+set}" ]; then echo "report $DAG_TEST_REPORT"; else echo "no report"; fi',
      env: ({ tests }) => ({ DAG_TEST_REPORT: tests.report }),
    });
    runShell(graph, { name: "no-bash", cmd: "echo hi", env: { PATH: "/nonexistent" } });
    run(graph, { name: "missing", cmd: ["dag-test-no-such-program"] });
    process.env["DAG_TEST_REPORT"] = "inherited";
    let results: Map<string, Result>;
    try {
      results = byName(await executeUnder(graph, ports));
    } finally {
      delete process.env["DAG_TEST_REPORT"];
    }
    assert.deepEqual(
      {
        statuses: Object.fromEntries([...results].map(([name, r]) => [name, r.status])),
        tests: errorOf(results.get("tests")),
        pipe: [
          errorOf(results.get("pipe")),
          await fs.readText(logPath(CAS, found(results.get("pipe"), "pipe").actionKey)),
        ],
        report: await fs.readText(logPath(CAS, found(results.get("report"), "report").actionKey)),
        noBash: errorOf(results.get("no-bash")),
        missing: errorOf(results.get("missing")),
      },
      {
        statuses: {
          tests: "failed",
          pipe: "failed",
          report: "done",
          "no-bash": "failed",
          missing: "failed",
        },
        tests: "its shell command exited 3",
        pipe: ["its shell command exited 1", ""],
        report: "no report\n",
        noBash:
          "could not start bash. Check that it is on the command's PATH and that its cwd exists.",
        missing:
          "could not start dag-test-no-such-program. Check that it is on the command's PATH and that its cwd exists.",
      },
    );
  });
});

describe("post", () => {
  test("runs after its deps even when they failed, not when its main failed, takes its main's outputs as main, and is never cached", async () => {
    const calls: string[][] = [];
    const { ports, fs } = createTestPorts();
    const exec: Exec = {
      run: async (cmd) => {
        calls.push(cmd);
        const [program, verb, path] = cmd;
        if (program === "bad") return exited(1, "no\n");
        if (verb === "start" && path) await fs.writeText(path, "42");
        return exited(0);
      },
    };
    ports.exec = exec;
    const graph = newGraph();
    const db = run(graph, {
      name: "up:db",
      cmd: ({ out }) => ["db", "start", out.pid],
      outputs: { pid: "pid" },
    });
    const broken = run(graph, { name: "up:broken", cmd: ["bad"] });
    const tests = run(graph, { name: "tests", cmd: ["bad"], deps: { db } });
    post(graph, {
      name: "down:db",
      main: db,
      cmd: ({ main }) => ["db", "stop", main.pid],
      // An input would make it cacheable, were it not a post.
      inputs: { version: "down-v1" },
      deps: { tests: settled(tests) },
    });
    post(graph, { name: "down:broken", main: broken, cmd: ["never"], deps: {} });
    const results = await executeUnder(graph, ports);
    const [, , stoppedPath] = found(
      calls.find((c) => c[1] === "stop"),
      "the stop call",
    );
    assert.deepEqual(
      {
        statuses: statuses(results),
        calls: calls.map((c) => c.slice(0, 2)),
        stoppedPid: await fs.readText(found(stoppedPath, "the stop call's pid path")),
        posts: Object.fromEntries(postNodes(graph)),
        uncached: graph
          .describe()
          .filter((n) => n.cacheable === false)
          .map((n) => n.name),
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
        posts: { "down:db": "up:db", "down:broken": "up:broken" },
        uncached: ["up:db", "up:broken", "tests", "down:db", "down:broken"],
      },
    );
  });
});
