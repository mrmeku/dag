import {
  actionsFor,
  execute,
  file,
  Graph,
  resultActionKey,
  settled,
  startGlobalTimer,
  wallClock,
  type ExecutionListener,
  type NodeResult,
} from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { addCommand } from "./commands.ts";
import type { ExecResult, Ports } from "./ports.ts";
import { createOutputRecorder, createTestPorts } from "./ports/memory.ts";
import { createExec, createFileSystem } from "./ports/real.ts";
import { runWorkflow } from "./runner.ts";

const CACHE_DIR = "/cache";
const newGraph = () => new Graph<Ports>();
const executeUnder = (
  graph: Graph<Ports>,
  ports: Ports,
  cacheDir = CACHE_DIR,
  onEvent: ExecutionListener = () => {},
) =>
  execute(
    graph,
    { ports, fs: ports.fs, clock: wallClock, startTimer: startGlobalTimer, cacheDir },
    { onEvent },
  );
const exited = (code: number, output = ""): ExecResult => ({
  ended: "exited",
  code,
  stdout: output,
  stderr: "",
  output,
  ok: code === 0,
});
/** How a node settled, in the words the run's output uses: built or cached, or its status. */
const outcomeOf = (result: NodeResult) =>
  result.status === "succeeded" ? (result.details.actionRan ? "built" : "cached") : result.status;
const byName = (results: NodeResult[]) => new Map(results.map((r) => [r.name, r]));
const statuses = (results: NodeResult[]) =>
  Object.fromEntries(results.map((r) => [r.name, outcomeOf(r)]));
const failureErrorOf = (result: NodeResult | undefined) =>
  result?.status === "failed" && result.error.message;
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
  test("takes a dep's output as its own argument or env value, its path when it starts, and its own out and outputDir; a nonzero exit fails it, and it prints what its command prints", async () => {
    const seen: Array<{ cmd: string[]; env: Record<string, string | undefined> | undefined }> = [];
    const { ports, fs } = createTestPorts({
      exec: {
        run: async (cmd, opts) => {
          seen.push({ cmd, env: opts?.env });
          const [program, path] = cmd;
          if (program === "pack" && path) await fs.writeText(path, "bytes");
          const result = program === "bad" ? exited(1, "err\n") : exited(0, "hello\n");
          opts?.onOutput?.(result.output);
          return result;
        },
      },
    });
    const graph = newGraph();
    const pack = addCommand(graph, {
      name: "pack",
      cmd: ({ out }) => ["pack", out.tarball],
      outputs: { tarball: "pkg.tgz" },
    });
    addCommand(graph, {
      name: "publish",
      deps: { pack },
      cmd: ({ pack }) => ["publish", pack.tarball],
      env: ({ pack, outputDir }) => ({ TARBALL: pack.tarball, OUT: outputDir, MODE: "dry" }),
    });
    addCommand(graph, { name: "bad", cmd: ["bad", "--flag"] });
    const output = createOutputRecorder();
    const results = byName(await executeUnder(graph, ports, CACHE_DIR, output.onEvent));
    const packed = found(results.get("pack"), "pack's result");
    const tarball =
      packed.status === "succeeded" &&
      `${CACHE_DIR}/v1/${packed.details.actionKey}/${packed.details.entry.contentHash}/pkg.tgz`;
    const publish = found(
      seen.find((s) => s.cmd[0] === "publish"),
      "the publish command",
    );
    assert.deepEqual(
      {
        packOutputs: packed.status === "succeeded" && packed.details.entry.outputs,
        publish: {
          ...publish,
          env: { ...publish.env, OUT: publish.env?.OUT?.replace(/[0-9a-f-]{36}$/, "<uuid>") },
        },
        publishLog: output.printed.get("publish"),
        bad: failureErrorOf(results.get("bad")),
      },
      {
        packOutputs: { tarball },
        publish: {
          cmd: ["publish", tarball],
          env: {
            TARBALL: tarball,
            OUT: `${CACHE_DIR}/tmp/<uuid>`,
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
    const statusesOf = async (packName: string, role: string, cacheDir = CACHE_DIR) => {
      const graph = newGraph();
      const pack = addCommand(graph, {
        name: packName,
        cmd: ({ out }) => ["pack", out.tarball],
        outputs: { tarball: "pkg.tgz" },
        cacheable: true,
      });
      addCommand(graph, {
        name: "publish",
        deps: { [role]: pack },
        cmd: (refs) => ["publish", found(refs[role], role).tarball],
        env: (refs) => ({ TARBALL: found(refs[role], role).tarball }),
        cacheable: true,
      });
      const results = await executeUnder(graph, ports, cacheDir);
      return {
        ...statuses(results),
        key: resultActionKey(found(byName(results).get("publish"), "publish")),
      };
    };
    const first = await statusesOf("pack", "pack");
    const { key, ...firstStatuses } = first;
    // Another cache dir gives every output another path, which must not change the key.
    const { key: elsewhere } = await statusesOf("pack", "pack", "/elsewhere");
    const { key: _renamedKey, ...renamed } = await statusesOf("pack:renamed", "pack");
    const { key: _otherKey, ...otherRole } = await statusesOf("pack", "tarballs");
    assert.deepEqual(
      { first: firstStatuses, renamed, otherRole, keyHoldsNoPath: elsewhere === key },
      {
        first: { pack: "built", publish: "built" },
        renamed: { "pack:renamed": "cached", publish: "cached" },
        otherRole: { pack: "cached", publish: "built" },
        keyHoldsNoPath: true,
      },
    );
  });

  test("keys a cmd and a shell task by their kinds, run and run-shell, beside what workflow.run and workflow.runShell keyed", async () => {
    const { ports, fs } = createTestPorts({
      files: { "src/a.ts": "a" },
      exec: {
        run: async ([program, path]) => {
          if (program === "pack" && path) await fs.writeText(path, "bytes");
          return exited(program === "false" ? 1 : 0);
        },
      },
    });
    const graph = newGraph();
    const pack = addCommand(graph, {
      name: "pack",
      cmd: ({ out }) => ["pack", out.tarball],
      outputs: { tarball: "pkg.tgz" },
      inputs: { "src/a.ts": file("src/a.ts") },
      cwd: "sub",
      env: { MODE: "dry" },
    });
    const tests = addCommand(graph, {
      name: "tests",
      cmd: ["false"],
      outputs: { report: "junit.xml" },
    });
    addCommand(graph, {
      name: "publish",
      deps: { pack, tests: settled(tests) },
      cmd: ({ pack, outputDir }) => ["publish", pack.tarball, "--out", outputDir],
      env: ({ pack, tests, out }) => ({
        TARBALL: pack.tarball,
        REPORT: tests.report,
        LOG: out.log,
        MODE: "dry",
      }),
      outputs: { log: "publish.log" },
    });
    addCommand(graph, {
      name: "size",
      deps: { pack },
      shell: 'gzip -c "$TARBALL" | wc -c',
      env: ({ pack, outputDir }) => ({ TARBALL: pack.tarball, OUT: outputDir }),
      inputs: { version: "size-v1" },
      cwd: "sub",
    });
    const results = await executeUnder(graph, ports);
    // What main's workflow.run and workflow.runShell keyed for the same graph, with each node's
    // kind.
    assert.deepEqual(
      Object.fromEntries(results.map((r) => [r.name, [outcomeOf(r), resultActionKey(r)]])),
      {
        tests: ["failed", "9c9d43ced0349e6966f09c288a2223d060fa452d1d579f9b64071f74a325b03d"],
        pack: ["built", "c9450dd8d43e15f5fe3febeaceffdc526c3928f1e291a2e1bd5e1c71ab17cfb3"],
        publish: ["failed", "1b293a851dcf379455bb36dc7701d8da307f3797cb7e1ef521c8cb67057a3a4b"],
        size: ["built", "7dfb0c52b9f7438230f0082f7527983fcb5ccc2589c1dc9a9f3ba6fe76e493a0"],
      },
    );
  });

  test("that declares no inputs runs every time, and one that declares inputs is cached on them; its own command does not count, and an explicit cacheable wins", async () => {
    const { ports } = createTestPorts({
      files: { "src/a.ts": "a" },
      exec: { run: async () => exited(0) },
    });
    const src = { "src/a.ts": file("src/a.ts") };
    const once = async () => {
      const graph = newGraph();
      addCommand(graph, { name: "smoke", cmd: ["curl", "-f", "localhost"] });
      addCommand(graph, { name: "lint", cmd: ["lint"], inputs: src });
      // A glob that matched nothing.
      addCommand(graph, { name: "empty", cmd: ["empty"], inputs: {} });
      addCommand(graph, { name: "publish", cmd: ["publish"], cacheable: true });
      addCommand(graph, { name: "e2e", cmd: ["e2e"], inputs: src, cacheable: false });
      return statuses(await executeUnder(graph, ports));
    };
    assert.deepEqual(
      [await once(), await once()],
      [
        { smoke: "built", lint: "built", empty: "built", publish: "built", e2e: "built" },
        { smoke: "built", lint: "cached", empty: "built", publish: "cached", e2e: "built" },
      ],
    );
  });

  test("is refused before anything runs when it puts its own output in a string", () => {
    const graph = newGraph();
    assert.deepEqual(
      {
        ownTemplateString: refusal(() =>
          addCommand(graph, {
            name: "x",
            outputs: { id: "id" },
            // @ts-expect-error its own output in a template string (TS2731)
            cmd: ({ out }) => [`${out.id}.tmp`],
          }),
        ),
        ownInEnv: refusal(() =>
          addCommand(graph, {
            name: "z",
            outputs: { id: "id" },
            cmd: ["write-id"],
            // @ts-expect-error its own output in a template string (TS2731)
            env: ({ out }) => ({ ID: `${out.id}.tmp` }),
          }),
        ),
        ownInShell: refusal(() =>
          addCommand(graph, {
            name: "y",
            shell: 'tar -cf "$OUT" .',
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
    addCommand(graph, {
      name: "ls",
      deps: { listing },
      cmd: ({ listing }) => ["ls", listing.files],
    });
    const results = byName(await executeUnder(graph, ports));
    const listed = found(results.get("files"), "the files node's result");
    const dir =
      listed.status === "succeeded" &&
      `${CACHE_DIR}/v1/${listed.details.actionKey}/${listed.details.entry.contentHash}`;
    assert.deepEqual(seen, [["ls", `${dir}/a.txt:${dir}/b.txt`]]);
  });

  test("refs reach a command as absolute paths when it starts, so one with its own cwd sees the same files under a relative cache directory; its outputs are absolute, and its log and durations sit where the run's options name", async () => {
    const root = mkdtempSync(join(tmpdir(), "dag-cwd-"));
    try {
      mkdirSync(join(root, "sub"));
      const fs = createFileSystem();
      const { ports } = createTestPorts({ exec: createExec() });
      ports.fs = fs;
      // Relative, as the CLI's .dag/cache is.
      const cacheDir = relative(process.cwd(), join(root, "cache"));
      const sub = relative(process.cwd(), join(root, "sub"));
      const buildLogDir = join(root, "build-logs");
      const durationsDir = join(root, "durations");
      const { results } = await runWorkflow({
        ports,
        cacheDir,
        historyDir: join(root, "history"),
        buildLogDir,
        durationsDir,
        implementation: async (graph) => {
          const pack = addCommand(graph, {
            name: "pack",
            shell: 'echo bytes > "$OUT"',
            env: ({ out }) => ({ OUT: out.tarball }),
            outputs: { tarball: "t.txt" },
          });
          addCommand(graph, {
            name: "list",
            deps: { pack },
            cwd: sub,
            cmd: ({ pack }) => ["cat", pack.tarball],
          });
          addCommand(graph, {
            name: "own",
            cwd: sub,
            shell: 'echo 1 > "$ID"',
            env: ({ out }) => ({ ID: out.id }),
            outputs: { id: "id" },
          });
        },
      });
      const byNode = byName(results);
      const own = found(byNode.get("own"), "own's result");
      const ownDir =
        own.status === "succeeded"
          ? `${root}/cache/v1/${own.details.actionKey}/${own.details.entry.contentHash}`
          : "";
      const listKey = resultActionKey(found(byNode.get("list"), "list's result"));
      assert.deepEqual(
        {
          statuses: Object.fromEntries([...byNode].map(([name, r]) => [name, outcomeOf(r)])),
          listed: await fs.readText(`${buildLogDir}/${listKey}.log`),
          own: {
            outputs: own.status === "succeeded" && own.details.entry.outputs,
            content: await fs.readText(`${ownDir}/id`),
          },
          durations: await fs.exists(`${durationsDir}/run.json`),
        },
        {
          statuses: { pack: "built", list: "built", own: "built" },
          listed: "bytes\n",
          own: { outputs: { id: `${ownDir}/id` }, content: "1\n" },
          durations: true,
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a shell task", () => {
  test("runs its string under bash -eo pipefail, where a settled dep's output is unset when the dep failed, even when inherited; a machine without bash fails the node, saying so, as a cmd task does for a program it cannot start", async () => {
    const { ports } = createTestPorts({ exec: createExec() });
    const graph = newGraph();
    const tests = addCommand(graph, {
      name: "tests",
      shell: "exit 3",
      outputs: { report: "junit.xml" },
    });
    addCommand(graph, { name: "pipe", shell: "false | cat; echo after" });
    addCommand(graph, {
      name: "report",
      deps: { tests: settled(tests) },
      shell:
        'if [ -n "${DAG_TEST_REPORT+set}" ]; then echo "report $DAG_TEST_REPORT"; else echo "no report"; fi',
      env: ({ tests }) => ({ DAG_TEST_REPORT: tests.report }),
    });
    addCommand(graph, { name: "no-bash", shell: "echo hi", env: { PATH: "/nonexistent" } });
    addCommand(graph, { name: "missing", cmd: ["dag-test-no-such-program"] });
    process.env["DAG_TEST_REPORT"] = "inherited";
    const output = createOutputRecorder();
    let results: Map<string, NodeResult>;
    try {
      results = byName(await executeUnder(graph, ports, CACHE_DIR, output.onEvent));
    } finally {
      delete process.env["DAG_TEST_REPORT"];
    }
    assert.deepEqual(
      {
        statuses: Object.fromEntries([...results].map(([name, r]) => [name, outcomeOf(r)])),
        tests: failureErrorOf(results.get("tests")),
        pipe: [failureErrorOf(results.get("pipe")), output.printed.get("pipe") ?? ""],
        report: output.printed.get("report"),
        noBash: failureErrorOf(results.get("no-bash")),
        missing: failureErrorOf(results.get("missing")),
      },
      {
        statuses: {
          tests: "failed",
          pipe: "failed",
          report: "built",
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
