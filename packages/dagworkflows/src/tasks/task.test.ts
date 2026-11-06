import {
  createMemoryFileSystem,
  errorMessage,
  execute,
  file,
  Graph,
  type ExecuteOptions,
  type FileSystem,
  type NodeResult,
} from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { manualTimer, okExec, steppingClock } from "../memory/index.ts";
import { addTask, type Exec, type ExecResult, type TaskPorts } from "./index.ts";

const CACHE_DIR = "/cache";
const exited = (code: number, stdout = ""): ExecResult => ({
  ended: "exited",
  code,
  stdout,
  stderr: "",
  output: stdout,
  ok: code === 0,
});
const portsOf = (exec: Exec, fs: FileSystem = createMemoryFileSystem()): TaskPorts => ({
  exec,
  clock: steppingClock(),
  fs,
});
/** Executes `graph` with dagraph's `execute`: each node's result and what it printed, by name. */
async function executeTasks(
  graph: Graph<TaskPorts>,
  ports: TaskPorts,
  options: ExecuteOptions = {},
) {
  const printed = new Map<string, string>();
  const results = await execute(
    graph,
    { ports, fs: ports.fs, clock: ports.clock, startTimer: manualTimer(), cacheDir: CACHE_DIR },
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
const outcomeOf = (result: NodeResult) =>
  result.status === "succeeded" ? (result.details.actionRan ? "built" : "cached") : result.status;
const failureOf = (result: NodeResult | undefined) => result?.status === "failed" && result.error;
/** The path the node wrote at `role`; it throws when it wrote none. */
const pathOf = (result: NodeResult | undefined, role: string) => {
  const outputs = result?.status === "succeeded" ? result.details.entry.outputs : undefined;
  const path = typeof outputs === "object" && !Array.isArray(outputs) ? outputs[role] : undefined;
  if (typeof path !== "string") throw new Error(`no ${role} written`);
  return path;
};
const refusal = (add: () => unknown) => {
  try {
    add();
    return "accepted";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

describe("an action task", () => {
  test("reads its inputs, deps and declared outputs as paths, runs commands through run and runShell and prints what they print and its own lines; a declared output missing on return fails it, and what its action throws reaches the engine unchanged", async () => {
    const commands: Array<{ cmd: string[]; env: unknown }> = [];
    const fs = createMemoryFileSystem({ "CHANGELOG.md": "## 1.0.0" });
    const ports = portsOf(
      {
        run: async (cmd, opts) => {
          commands.push({ cmd, env: opts?.env });
          const result = cmd[0] === "tar" ? exited(0, "a.txt\nb.txt\n") : exited(0, "2\n");
          opts?.onOutput?.(result.output);
          return result;
        },
      },
      fs,
    );
    const graph = new Graph<TaskPorts>();
    const pack = addTask(graph, {
      name: "pack",
      outputs: { tarball: "pkg.tgz" },
      action: async ({ out, ports }) => ports.fs.writeText(out.tarball, "bytes"),
    });
    addTask(graph, {
      name: "notes",
      deps: { pack },
      inputs: { version: "notes-v1", changelog: file("CHANGELOG.md"), mode: "release" },
      outputs: { notes: "notes.md" },
      action: async ({ inputs, depOutputs, out, ports, run, runShell, log, warn }) => {
        const files = await run(["tar", "-tzf", depOutputs.pack.tarball.path]);
        const count = await runShell('tar -tzf "$TARBALL" | wc -l', {
          env: { TARBALL: depOutputs.pack.tarball.path },
        });
        log(`${inputs.mode} build`);
        warn("50% of the files,\nno more");
        const changes = await inputs.changelog.text();
        await ports.fs.writeText(out.notes, `${changes}\n${files}${count}`);
      },
    });
    addTask(graph, { name: "forgot", outputs: { report: "report.xml" }, action: async () => {} });
    addTask(graph, {
      name: "throws",
      action: async () => {
        throw new TypeError("no notes", { cause: { exitCode: 2 } });
      },
    });
    const { results, printed } = await executeTasks(graph, ports);
    const tarball = pathOf(results.get("pack"), "tarball");
    assert.deepEqual(
      {
        notes: await fs.readText(pathOf(results.get("notes"), "notes")),
        log: printed.get("notes"),
        commands,
        forgot: failureOf(results.get("forgot")),
        throws: failureOf(results.get("throws")),
      },
      {
        notes: "## 1.0.0\na.txt\nb.txt\n2\n",
        log: "a.txt\nb.txt\n2\nrelease build\n::warning title=notes::50%25 of the files,%0Ano more\n",
        commands: [
          { cmd: ["tar", "-tzf", tarball], env: undefined },
          {
            cmd: [
              "bash",
              "--noprofile",
              "--norc",
              "-eo",
              "pipefail",
              "-c",
              'tar -tzf "$TARBALL" | wc -l',
            ],
            env: { TARBALL: tarball },
          },
        ],
        // No command ran, so no cause.
        forgot: {
          name: "Error",
          message:
            'output "report" (report.xml) was not written. Write it at out.report before the action returns.',
        },
        throws: { name: "TypeError", message: "no notes", cause: { exitCode: 2 } },
      },
    );
  });

  test("keys its kind: identical cached cmd tasks share one entry, a renamed cmd task hits, and a renamed action task runs again", async () => {
    const ports = portsOf(okExec);
    const once = async (lint: string[], notes: string) => {
      const graph = new Graph<TaskPorts>();
      for (const name of lint)
        addTask(graph, { name, cmd: ["lint"], inputs: { version: "lint-v1" } });
      addTask(graph, {
        name: notes,
        inputs: { version: "notes-v1" },
        action: ({ log }) => log("x"),
      });
      const { results } = await executeTasks(graph, ports);
      return Object.fromEntries([...results].map(([name, r]) => [name, outcomeOf(r)]));
    };
    assert.deepEqual(
      [await once(["lint"], "notes"), await once(["lint", "lint:copy"], "notes:renamed")],
      [
        { lint: "built", notes: "built" },
        { lint: "cached", "lint:copy": "cached", "notes:renamed": "built" },
      ],
    );
  });

  test("is cached only when an input holds a value", async () => {
    const ports = portsOf(okExec);
    const once = async () => {
      const graph = new Graph<TaskPorts>();
      addTask(graph, { name: "unset", inputs: { mode: undefined }, action: ({ log }) => log("x") });
      addTask(graph, { name: "set", inputs: { mode: "ci" }, action: ({ log }) => log("x") });
      const { results } = await executeTasks(graph, ports);
      return Object.fromEntries([...results].map(([name, r]) => [name, outcomeOf(r)]));
    };
    assert.deepEqual(
      [await once(), await once()],
      [
        { unset: "built", set: "built" },
        { unset: "built", set: "cached" },
      ],
    );
  });

  test("whose input file does not exist fails unstarted, with the file system's error", async () => {
    const ran: string[] = [];
    const graph = new Graph<TaskPorts>();
    addTask(graph, {
      name: "notes",
      inputs: { changelog: file("CHANGELOG.md") },
      action: () => void ran.push("notes"),
    });
    const { results } = await executeTasks(graph, portsOf(okExec));
    assert.deepEqual(
      { failure: failureOf(results.get("notes")), ran },
      { failure: { name: "Error", message: "ENOENT: CHANGELOG.md" }, ran: [] },
    );
  });

  test("has run reject a command the stop signal ended as stopped, whatever it exited with, and one run after the signal as stopped before it started", async () => {
    const started: string[] = [];
    const caught: Record<string, string> = {};
    const endings: Record<string, ExecResult> = {
      trap: exited(0),
      slow: exited(130),
      killed: { ...exited(-1), ended: "signalled" },
    };
    const ports = portsOf({
      run: async ([program = ""], opts) => {
        if (opts?.signal?.aborted) return { ...exited(-1), ended: "not-started" };
        started.push(program);
        // Each command runs until the signal fires, then ends as it was told to.
        return new Promise((resolve) =>
          opts?.signal?.addEventListener("abort", () => resolve(endings[program] ?? exited(0)), {
            once: true,
          }),
        );
      },
    });
    const attempt = (run: (argv: readonly string[]) => Promise<string>, program: string) =>
      run([program]).then(
        () => {},
        (e: unknown) => void (caught[program] = errorMessage(e)),
      );
    const graph = new Graph<TaskPorts>();
    addTask(graph, { name: "trap", action: ({ run }) => attempt(run, "trap") });
    addTask(graph, {
      name: "slow",
      action: async ({ run }) => {
        await attempt(run, "slow");
        await attempt(run, "late");
      },
    });
    addTask(graph, { name: "killed", action: ({ run }) => attempt(run, "killed") });
    const cancel = new AbortController();
    const executed = executeTasks(graph, ports, { signal: cancel.signal });
    while (started.length < 3) await new Promise((resolve) => setImmediate(resolve));
    cancel.abort();
    await executed;
    assert.deepEqual(caught, {
      trap: "trap was stopped",
      slow: "slow was stopped",
      killed: "killed was stopped",
      late: "late was stopped before it started",
    });
  });

  test("is refused when it declares an output that is not a file in its output directory", () => {
    const declaring = (report: string) => () =>
      addTask(new Graph<TaskPorts>(), { name: "x", outputs: { report }, action: async () => {} });
    const refused = (file: string, hint: string) =>
      `task "x": outputs.report is "${file}", not a file in its output directory. Name a file in it${hint}.`;
    assert.deepEqual(
      {
        absolute: refusal(declaring("/tmp/report.xml")),
        parent: refusal(declaring("reports/../../report.xml")),
        empty: refusal(declaring("")),
        dot: refusal(declaring(".")),
        directory: refusal(declaring("reports/")),
        nested: refusal(declaring("reports/junit.xml")),
      },
      {
        absolute: refused("/tmp/report.xml", ', as "report.xml"'),
        parent: refused("reports/../../report.xml", ', as "report.xml"'),
        empty: refused("", ""),
        dot: refused(".", ""),
        directory: refused("reports/", ""),
        nested: "accepted",
      },
    );
  });

  test("fails as for a missing output, with its last command's cause, when a file stands where its output's directory would", async () => {
    const graph = new Graph<TaskPorts>();
    addTask(graph, {
      name: "report",
      outputs: { report: "build/report.txt" },
      action: async ({ outputDir, ports, run }) => {
        await run(["make", "report"]);
        await ports.fs.writeText(`${outputDir}/build`, "a file");
      },
    });
    const { results } = await executeTasks(graph, portsOf(okExec));
    assert.deepEqual(failureOf(results.get("report")), {
      name: "Error",
      message:
        'output "report" (build/report.txt) was not written. Write it at out.report before the action returns.',
      cause: { argv: ["make", "report"], cwd: ".", ended: "exited", code: 0 },
    });
  });

  test("fails with the cache's words when its output is a directory, or a link its file system answers lstat for", async () => {
    const memory = createMemoryFileSystem();
    const links = new Set<string>();
    // A link that leads nowhere: lstat finds it, links not followed.
    const fs: FileSystem = {
      ...memory,
      lstat: async (path) =>
        links.has(path)
          ? { isFile: () => false, mode: 0o777, size: 0, mtimeMs: 0 }
          : memory.lstat(path),
    };
    const graph = new Graph<TaskPorts>();
    addTask(graph, {
      name: "directory",
      outputs: { report: "report" },
      action: async ({ out, ports }) => ports.fs.ensureDir(out.report),
    });
    addTask(graph, {
      name: "link",
      outputs: { report: "report.xml" },
      action: ({ out }) => void links.add(out.report),
    });
    const { results } = await executeTasks(graph, portsOf(okExec, fs));
    const notAFile = (file: string) => ({
      name: "Error",
      message: `output "report" (${file}) is not a regular file. Return files only, never a directory or a symbolic link.`,
    });
    assert.deepEqual(
      { directory: failureOf(results.get("directory")), link: failureOf(results.get("link")) },
      { directory: notAFile("report"), link: notAFile("report.xml") },
    );
  });
});
