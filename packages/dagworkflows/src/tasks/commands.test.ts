import {
  actionsFor,
  createMemoryFileSystem,
  execute,
  file,
  Graph,
  resultActionKey,
  settled,
  type ExecuteOptions,
  type NodeResult,
} from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { manualTimer, steppingClock } from "../memory/index.ts";
import { addTask, type Exec, type ExecResult, type TaskPorts } from "./index.ts";

const CACHE_DIR = "/cache";
const BASH = ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c"];
const exited = (code: number, output = ""): ExecResult => ({
  ended: "exited",
  code,
  stdout: output,
  stderr: "",
  output,
  ok: code === 0,
});
const portsOf = (run: Exec["run"], files: Record<string, string> = {}): TaskPorts => ({
  exec: { run },
  clock: steppingClock(),
  fs: createMemoryFileSystem(files),
});
/** Executes `graph` with dagraph's `execute`: each node's result and what it printed, by name. */
async function executeTasks(
  graph: Graph<TaskPorts>,
  ports: TaskPorts,
  { cacheDir = CACHE_DIR, ...options }: { cacheDir?: string } & ExecuteOptions = {},
) {
  const printed = new Map<string, string>();
  const results = await execute(
    graph,
    { ports, fs: ports.fs, clock: ports.clock, startTimer: manualTimer(), cacheDir },
    {
      ...options,
      onEvent: (event) => {
        if (event.type === "output")
          printed.set(event.node, (printed.get(event.node) ?? "") + event.chunk);
      },
    },
  );
  return { results: new Map(results.map((r) => [r.name, r])), printed };
}
/** How a node settled, in the words the run's output uses: built or cached, or its status. */
const outcomeOf = (result: NodeResult | undefined) =>
  result?.status === "succeeded" ? (result.details.actionRan ? "built" : "cached") : result?.status;
const statuses = (results: Map<string, NodeResult>) =>
  Object.fromEntries([...results].map(([name, r]) => [name, outcomeOf(r)]));
const failureOf = (result: NodeResult | undefined) => result?.status === "failed" && result.error;
/** The directory `result` committed its outputs in. */
const entryDir = (result: NodeResult | undefined) =>
  result?.status === "succeeded" &&
  `${CACHE_DIR}/v1/${result.details.actionKey}/${result.details.entry.contentHash}`;
/** `path` with the staging directory's uuid, which differs each attempt, as `<uuid>`. */
const withoutUuid = (path: string) => path.replace(/\/tmp\/[0-9a-f-]{36}/, "/tmp/<uuid>");
const refusal = (add: () => unknown) => {
  try {
    add();
    return "accepted";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

describe("a command", () => {
  test("takes a dep's output as its own argument or env value, its path when it starts, and its own out and outputDir, over the environment it inherits; a nonzero exit fails it, and it prints what its command prints", async () => {
    const seen: Array<{ cmd: string[]; env: Record<string, string | undefined> | undefined }> = [];
    const ports = portsOf(async (cmd, opts) => {
      seen.push({ cmd, env: opts?.env });
      const [program, path] = cmd;
      if (program === "pack" && path) await ports.fs.writeText(path, "bytes");
      const result = program === "bad" ? exited(1, "err\n") : exited(0, "hello\n");
      opts?.onOutput?.(result.output);
      return result;
    });
    const graph = new Graph<TaskPorts>();
    const pack = addTask(graph, {
      name: "pack",
      cmd: ({ out }) => ["pack", out.tarball],
      outputs: { tarball: "pkg.tgz" },
    });
    addTask(graph, {
      name: "publish",
      deps: { pack },
      cmd: ({ pack }) => ["publish", pack.tarball],
      env: ({ pack, outputDir }) => ({ TARBALL: pack.tarball, OUT: outputDir, MODE: "dry" }),
    });
    addTask(graph, { name: "bad", cmd: ["bad", "--flag"] });
    const { results, printed } = await executeTasks(graph, ports);
    const tarball = `${entryDir(results.get("pack"))}/pkg.tgz`;
    const packed = results.get("pack");
    assert.deepEqual(
      {
        packOutputs: packed?.status === "succeeded" && packed.details.entry.outputs,
        commands: seen.map(({ cmd, env }) => ({
          cmd: cmd.map(withoutUuid),
          env:
            env &&
            Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v && withoutUuid(v)])),
        })),
        publishLog: printed.get("publish"),
        bad: failureOf(results.get("bad")),
      },
      {
        packOutputs: { tarball },
        commands: [
          // Nothing is set over what it inherits but its env.
          { cmd: ["pack", `${CACHE_DIR}/tmp/<uuid>/pkg.tgz`], env: {} },
          { cmd: ["bad", "--flag"], env: {} },
          {
            cmd: ["publish", tarball],
            env: { TARBALL: tarball, OUT: `${CACHE_DIR}/tmp/<uuid>`, MODE: "dry" },
          },
        ],
        publishLog: "hello\n",
        bad: {
          name: "Error",
          message: "bad --flag exited 1",
          cause: { argv: ["bad", "--flag"], cwd: ".", ended: "exited", code: 1 },
        },
      },
    );
  });

  test("keys a dep's output by the role it points through and the output's name: renaming the dep's node runs neither it nor its dependents again, and another role does", async () => {
    const ports = portsOf(async ([program, path]) => {
      if (program === "pack" && path) await ports.fs.writeText(path, "bytes");
      return exited(0);
    });
    const statusesOf = async (packName: string, role: string, cacheDir = CACHE_DIR) => {
      const graph = new Graph<TaskPorts>();
      const pack = addTask(graph, {
        name: packName,
        cmd: ({ out }) => ["pack", out.tarball],
        outputs: { tarball: "pkg.tgz" },
        cacheable: true,
      });
      const refOf = <T>(ref: T | undefined) => {
        if (ref === undefined) throw new Error(`no role ${role}`);
        return ref;
      };
      addTask(graph, {
        name: "publish",
        deps: { [role]: pack },
        cmd: (refs) => ["publish", refOf(refs[role]).tarball],
        env: (refs) => ({ TARBALL: refOf(refs[role]).tarball }),
        cacheable: true,
      });
      const { results } = await executeTasks(graph, ports, { cacheDir });
      const publish = results.get("publish");
      return { ...statuses(results), key: publish && resultActionKey(publish) };
    };
    const { key, ...first } = await statusesOf("pack", "pack");
    // Another cache dir gives every output another path, which must not change the key.
    const { key: elsewhere } = await statusesOf("pack", "pack", "/elsewhere");
    const { key: _renamedKey, ...renamed } = await statusesOf("pack:renamed", "pack");
    const { key: _otherKey, ...otherRole } = await statusesOf("pack", "tarballs");
    assert.deepEqual(
      { first, renamed, otherRole, keyHoldsNoPath: elsewhere === key },
      {
        first: { pack: "built", publish: "built" },
        renamed: { "pack:renamed": "cached", publish: "cached" },
        otherRole: { pack: "cached", publish: "built" },
        keyHoldsNoPath: true,
      },
    );
  });

  test("keys a cmd and a shell task by their kinds, run and run-shell, with the keys the caches already hold", async () => {
    const ports = portsOf(
      async ([program, path]) => {
        if (program === "pack" && path) await ports.fs.writeText(path, "bytes");
        return exited(program === "false" ? 1 : 0);
      },
      { "src/a.ts": "a" },
    );
    const graph = new Graph<TaskPorts>();
    const pack = addTask(graph, {
      name: "pack",
      cmd: ({ out }) => ["pack", out.tarball],
      outputs: { tarball: "pkg.tgz" },
      inputs: { "src/a.ts": file("src/a.ts") },
      cwd: "sub",
      env: { MODE: "dry" },
    });
    const tests = addTask(graph, {
      name: "tests",
      cmd: ["false"],
      outputs: { report: "junit.xml" },
    });
    addTask(graph, {
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
    addTask(graph, {
      name: "size",
      deps: { pack },
      shell: 'gzip -c "$TARBALL" | wc -c',
      env: ({ pack, outputDir }) => ({ TARBALL: pack.tarball, OUT: outputDir }),
      inputs: { version: "size-v1" },
      cwd: "sub",
    });
    const { results } = await executeTasks(graph, ports);
    // Golden keys: a change here misses every entry the caches hold for a command.
    assert.deepEqual(
      Object.fromEntries(
        [...results].map(([name, r]) => [name, [outcomeOf(r), resultActionKey(r)]]),
      ),
      {
        tests: ["failed", "9c9d43ced0349e6966f09c288a2223d060fa452d1d579f9b64071f74a325b03d"],
        pack: ["built", "c9450dd8d43e15f5fe3febeaceffdc526c3928f1e291a2e1bd5e1c71ab17cfb3"],
        publish: ["failed", "1b293a851dcf379455bb36dc7701d8da307f3797cb7e1ef521c8cb67057a3a4b"],
        size: ["built", "7dfb0c52b9f7438230f0082f7527983fcb5ccc2589c1dc9a9f3ba6fe76e493a0"],
      },
    );
  });

  test("that declares no inputs, or none that holds a value, runs every time, and one that declares inputs is cached on them; its own command does not count, and an explicit cacheable wins", async () => {
    const ports = portsOf(async () => exited(0), { "src/a.ts": "a" });
    const src = { "src/a.ts": file("src/a.ts") };
    const once = async () => {
      const graph = new Graph<TaskPorts>();
      addTask(graph, { name: "smoke", cmd: ["curl", "-f", "localhost"] });
      addTask(graph, { name: "lint", cmd: ["lint"], inputs: src });
      // A glob that matched nothing.
      addTask(graph, { name: "empty", cmd: ["empty"], inputs: {} });
      // A variable that is not set.
      addTask(graph, { name: "unset", cmd: ["unset"], inputs: { mode: undefined } });
      addTask(graph, { name: "publish", cmd: ["publish"], cacheable: true });
      addTask(graph, { name: "e2e", cmd: ["e2e"], inputs: src, cacheable: false });
      return statuses((await executeTasks(graph, ports)).results);
    };
    assert.deepEqual(
      [await once(), await once()],
      [
        {
          smoke: "built",
          lint: "built",
          empty: "built",
          unset: "built",
          publish: "built",
          e2e: "built",
        },
        {
          smoke: "built",
          lint: "cached",
          empty: "built",
          unset: "built",
          publish: "cached",
          e2e: "built",
        },
      ],
    );
  });

  test("makes its output directory but no directory in it, which its command makes", async () => {
    let made = {};
    const ports = portsOf(async ([, outputDir = ""]) => {
      const isThere = (path: string) =>
        ports.fs.lstat(path).then(
          () => true,
          () => false,
        );
      made = { outputDir: await isThere(outputDir), build: await isThere(`${outputDir}/build`) };
      return exited(0);
    });
    const graph = new Graph<TaskPorts>();
    addTask(graph, {
      name: "report",
      cmd: ({ outputDir, out }) => ["make", outputDir, out.report],
      outputs: { report: "build/report.txt" },
    });
    await executeTasks(graph, ports);
    assert.deepEqual(made, { outputDir: true, build: false });
  });

  test("is refused before anything runs when it puts a ref in a string", () => {
    const graph = new Graph<TaskPorts>();
    const pack = addTask(graph, { name: "pack", cmd: ["pack"], outputs: { tarball: "pkg.tgz" } });
    assert.deepEqual(
      {
        depInArgument: refusal(() =>
          addTask(graph, {
            name: "a",
            deps: { pack },
            // @ts-expect-error a dep's output in a template string (TS2731)
            cmd: ({ pack }) => [`--file=${pack.tarball}`],
          }),
        ),
        ownTemplateString: refusal(() =>
          addTask(graph, {
            name: "x",
            outputs: { id: "id" },
            // @ts-expect-error its own output in a template string (TS2731)
            cmd: ({ out }) => [`${out.id}.tmp`],
          }),
        ),
        ownInEnv: refusal(() =>
          addTask(graph, {
            name: "z",
            outputs: { id: "id" },
            cmd: ["write-id"],
            // @ts-expect-error its own output in a template string (TS2731)
            env: ({ out }) => ({ ID: `${out.id}.tmp` }),
          }),
        ),
        ownInShell: refusal(() =>
          addTask(graph, {
            name: "y",
            shell: 'tar -cf "$OUT" .',
            // @ts-expect-error its own output dir in a template string (TS2731)
            env: ({ outputDir }) => ({ OUT: `${outputDir}/pkg.tar` }),
          }),
        ),
      },
      {
        depInArgument:
          'node "a": pack.tarball can\'t be part of a string: its path exists only once "pack" has run. Make it its own array item or property: [..., pack.tarball] or { tarball: pack.tarball }.',
        ownTemplateString:
          'node "x": out.id can\'t be part of a string. Make it its own argument: cmd: ({ out }) => [..., out.id].',
        ownInEnv:
          'node "z": out.id can\'t be part of a string. Make it its own env value: env: ({ out }) => ({ OUT: out.id }).',
        ownInShell:
          'node "y": outputDir can\'t be part of a string. Make it its own env value, read quoted: env: ({ outputDir }) => ({ OUT: outputDir }), then "$OUT".',
      },
    );
  });

  test("gets a dep's output holding a list of paths as those paths joined with :, and a settled dep's output that did not succeed unset in its env", async () => {
    const seen: Array<{ cmd: string[]; env: Record<string, string | undefined> | undefined }> = [];
    const ports = portsOf(async (cmd, opts) => {
      seen.push({ cmd, env: opts?.env });
      return exited(cmd.includes("exit 3") ? 3 : 0);
    });
    const graph = new Graph<TaskPorts>();
    const files = actionsFor<TaskPorts>()({
      kind: "files",
      action: async ({ outputDir, ports }) => {
        const paths = [`${outputDir}/a.txt`, `${outputDir}/b.txt`];
        for (const path of paths) await ports.fs.writeText(path, path);
        return { files: paths };
      },
    });
    const listing = files.addNode(graph, {});
    const tests = addTask(graph, {
      name: "tests",
      shell: "exit 3",
      outputs: { report: "junit.xml" },
    });
    addTask(graph, {
      name: "ls",
      deps: { listing, tests: settled(tests) },
      cmd: ({ listing }) => ["ls", listing.files],
      env: ({ tests }) => ({ REPORT: tests.report }),
    });
    const { results } = await executeTasks(graph, ports);
    const dir = entryDir(results.get("files"));
    assert.deepEqual(
      { seen, tests: failureOf(results.get("tests")) },
      {
        seen: [
          { cmd: [...BASH, "exit 3"], env: {} },
          { cmd: ["ls", `${dir}/a.txt:${dir}/b.txt`], env: { REPORT: undefined } },
        ],
        tests: {
          name: "Error",
          message: "its shell command exited 3",
          cause: { argv: [...BASH, "exit 3"], cwd: ".", ended: "exited", code: 3 },
        },
      },
    );
  });

  test("fails in words that say how its command ended, with that command as the cause", async () => {
    const ended = (how: ExecResult["ended"]): ExecResult => ({ ...exited(-1), ended: how });
    const ports = portsOf(async ([program], opts) => {
      if (program === "killed") return ended("signalled");
      if (program === "missing" || opts?.env?.PATH === "/nonexistent") return ended("not-started");
      if (program === "touch") return exited(0);
      return exited(1);
    });
    const graph = new Graph<TaskPorts>();
    addTask(graph, { name: "killed", cmd: ["killed"], cwd: "sub" });
    addTask(graph, { name: "missing", cmd: ["missing", "--flag"] });
    addTask(graph, { name: "no-bash", shell: "echo hi", env: { PATH: "/nonexistent" } });
    addTask(graph, { name: "forgot", cmd: ["touch"], outputs: { report: "report.xml" } });
    const { results } = await executeTasks(graph, ports);
    const cause = (argv: string[], how: ExecResult["ended"], code = -1, cwd = ".") => ({
      argv,
      cwd,
      ended: how,
      code,
    });
    assert.deepEqual(Object.fromEntries([...results].map(([name, r]) => [name, failureOf(r)])), {
      killed: {
        name: "Error",
        message: "killed was killed by a signal",
        cause: cause(["killed"], "signalled", -1, "sub"),
      },
      missing: {
        name: "Error",
        message:
          "could not start missing. Check that it is on the command's PATH and that its cwd exists.",
        cause: cause(["missing", "--flag"], "not-started"),
      },
      "no-bash": {
        name: "Error",
        message:
          "could not start bash. Check that it is on the command's PATH and that its cwd exists.",
        cause: cause([...BASH, "echo hi"], "not-started"),
      },
      forgot: {
        name: "Error",
        message:
          'output "report" (report.xml) was not written. Write it at out.report before the action returns.',
        cause: cause(["touch"], "exited", 0),
      },
    });
  });

  test("stopped by a cancel is cancelled, and by its own timeout fails as a TimeoutError, whatever its command exited with", async () => {
    const started: string[] = [];
    // Each command runs until the signal fires, then exits as it was told to: `trap` exits 0.
    const ports = portsOf(
      async ([program = ""], opts) =>
        new Promise((resolve) => {
          started.push(program);
          opts?.signal?.addEventListener("abort", () =>
            resolve(exited(program === "trap" ? 0 : 130)),
          );
        }),
    );
    const timer = manualTimer();
    const graph = new Graph<TaskPorts>();
    addTask(graph, { name: "trap", cmd: ["trap"], timeoutMs: 50 });
    addTask(graph, { name: "slow", cmd: ["slow"], timeoutMs: 50 });
    const timedOut = execute(graph, {
      ports,
      fs: ports.fs,
      clock: ports.clock,
      startTimer: timer,
      cacheDir: CACHE_DIR,
    });
    const cancel = new AbortController();
    const cancelGraph = new Graph<TaskPorts>();
    addTask(cancelGraph, { name: "trap", cmd: ["trap"] });
    addTask(cancelGraph, { name: "slow", cmd: ["slow"] });
    const cancelled = executeTasks(cancelGraph, ports, { signal: cancel.signal });
    while (started.length < 4) await new Promise((resolve) => setImmediate(resolve));
    timer.fire();
    cancel.abort();
    const timeouts = new Map((await timedOut).map((r) => [r.name, failureOf(r)]));
    const timeout = (argv: string[], code: number) => ({
      name: "TimeoutError",
      message: "timed out after 50 ms",
      cause: { argv, cwd: ".", ended: "exited", code },
    });
    assert.deepEqual(
      {
        timeouts: Object.fromEntries(timeouts),
        cancelled: statuses((await cancelled).results),
      },
      {
        timeouts: { trap: timeout(["trap"], 0), slow: timeout(["slow"], 130) },
        cancelled: { trap: "cancelled", slow: "cancelled" },
      },
    );
  });
});
