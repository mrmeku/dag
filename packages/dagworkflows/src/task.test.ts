import {
  execute,
  file,
  Graph,
  MemCache,
  type DepRecord,
  type InputRecord,
  type Result,
} from "@mrmeku/dagraph";
import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { addCommand } from "./commands.ts";
import type { ExecResult, Ports } from "./ports.ts";
import { createTestPorts } from "./ports/memory.ts";
import { createExec } from "./ports/real.ts";
import { runWorkflow } from "./runner.ts";
import { logPath } from "./step-records.ts";
import { addTask, type ActionTaskSpec } from "./task.ts";

const CAS = "/cas";
const executeUnder = (graph: Graph<Ports>, ports: Ports, cache = new MemCache()) =>
  execute(graph, { ports, cache, fs: ports.fs, clock: Date, casBaseDir: CAS });
const exited = (code: number, stdout = ""): ExecResult => ({
  ended: "exited",
  code,
  stdout,
  stderr: "",
  output: stdout,
  ok: code === 0,
});
const refusal = (add: () => unknown) => {
  try {
    add();
    return "accepted";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};
/** The result of the node `name`; it throws when the run has none. */
const resultOf = (results: Result[], name: string) => {
  const result = results.find((r) => r.name === name);
  if (result === undefined) throw new Error(`no result for "${name}"`);
  return result;
};
/** The path the node `name` wrote at `role`; it throws when it wrote none. */
const pathOf = (results: Result[], name: string, role: string) => {
  const result = resultOf(results, name);
  const outputs = result.status === "done" ? result.outputs : undefined;
  const path = typeof outputs === "object" && !Array.isArray(outputs) ? outputs[role] : undefined;
  if (typeof path !== "string") throw new Error(`"${name}" wrote no ${role}`);
  return path;
};
const task = <
  D extends DepRecord,
  O extends string = never,
  I extends InputRecord = Record<never, never>,
>(
  graph: Graph<Ports>,
  spec: ActionTaskSpec<string, D, O, I>,
) => addTask(graph, spec);

describe("a task", () => {
  test("reads its inputs, deps and declared outputs as paths, runs commands through its shell and writes its own lines to its log; a declared output missing on return fails it, and what its action throws reaches the engine unchanged", async () => {
    const commands: Array<{ cmd: string[]; env: unknown }> = [];
    const { ports, fs } = createTestPorts({
      files: { "CHANGELOG.md": "## 1.0.0" },
      env: { MODE: "release" },
      exec: {
        run: async (cmd, opts) => {
          commands.push({ cmd, env: opts?.env });
          return cmd[0] === "tar" ? exited(0, "a.txt\nb.txt\n") : exited(0, "2\n");
        },
      },
    });
    const graph = new Graph<Ports>();
    const pack = task(graph, {
      name: "pack",
      outputs: { tarball: "pkg.tgz" },
      action: async ({ out, ports }) => ports.fs.writeText(out.tarball, "bytes"),
    });
    task(graph, {
      name: "notes",
      deps: { pack },
      inputs: {
        version: "notes-v1",
        changelog: file("CHANGELOG.md"),
        mode: ports.env.MODE ?? null,
        locale: ports.env.LOCALE ?? null,
      },
      outputs: { notes: "notes.md" },
      action: async ({ inputs, depOutputs, out, ports, run, runShell, log, warn }) => {
        const files = await run(["tar", "-tzf", depOutputs.pack.tarball.path]);
        const count = await runShell('tar -tzf "$TARBALL" | wc -l', {
          env: { TARBALL: depOutputs.pack.tarball.path },
        });
        log(`${inputs.mode} build, locale ${inputs.locale}`);
        warn("50% of the files,\nno more");
        const changes = await inputs.changelog.text();
        await ports.fs.writeText(out.notes, `${changes}\n${files}${count}`);
      },
    });
    task(graph, { name: "forgot", outputs: { report: "report.xml" }, action: async () => {} });
    task(graph, {
      name: "throws",
      action: async () => {
        throw new TypeError("no notes", { cause: { exitCode: 2 } });
      },
    });
    const results = await executeUnder(graph, ports);
    const tarball = pathOf(results, "pack", "tarball");
    const failure = (name: string) => {
      const result = resultOf(results, name);
      return result.status === "failed" && result.error;
    };
    assert.deepEqual(
      {
        notes: await fs.readText(pathOf(results, "notes", "notes")),
        log: await fs.readText(logPath(CAS, resultOf(results, "notes").actionKey)),
        commands,
        forgot: failure("forgot"),
        throws: failure("throws"),
      },
      {
        notes: "## 1.0.0\na.txt\nb.txt\n2\n",
        log: "a.txt\nb.txt\n2\nrelease build, locale null\n::warning title=notes::50%25 of the files,%0Ano more\n",
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
        forgot: {
          name: "Error",
          message:
            'output "report" (report.xml) was not written. Write it at out.report before the action returns.',
        },
        throws: { name: "TypeError", message: "no notes", cause: { exitCode: 2 } },
      },
    );
  });

  test("gets its out and depOutputs as absolute paths, so a command it runs with its own cwd finds them under a relative CAS directory; the outputs it returns stay relative", async () => {
    const root = mkdtempSync(join(tmpdir(), "dag-task-cwd-"));
    try {
      mkdirSync(join(root, "sub"));
      const { ports } = createTestPorts({ exec: createExec() });
      ports.fs = createNodeDagFs();
      // Relative, as the CLI's .dag/cas is.
      const cas = relative(process.cwd(), join(root, "cas"));
      const sub = relative(process.cwd(), join(root, "sub"));
      const { results } = await runWorkflow({
        ports,
        casBaseDir: cas,
        historyDir: join(root, "history"),
        implementation: async (graph) => {
          const pack = task(graph, {
            name: "pack",
            outputs: { tarball: "t.txt" },
            action: async ({ out, runShell }) =>
              void (await runShell('echo bytes > "$OUT"', { cwd: sub, env: { OUT: out.tarball } })),
          });
          task(graph, {
            name: "copy",
            deps: { pack },
            outputs: { copy: "copy.txt" },
            action: async ({ depOutputs, out, run }) =>
              void (await run(["cp", depOutputs.pack.tarball.path, out.copy], { cwd: sub })),
          });
        },
      });
      const copy = resultOf(results, "copy");
      const dir = copy.status === "done" ? `${copy.actionKey}/out-${copy.contentHash}` : "";
      assert.deepEqual(
        {
          statuses: results.map((r) => [r.name, r.status]),
          outputs: copy.status === "done" && copy.outputs,
          copied: await ports.fs.readText(`${cas}/${dir}/copy.txt`),
        },
        {
          statuses: [
            ["pack", "done"],
            ["copy", "done"],
          ],
          outputs: { copy: `${cas}/${dir}/copy.txt` },
          copied: "bytes\n",
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keys its kind: identical cached cmd tasks share one entry, a renamed cmd task hits, and a renamed action task runs again", async () => {
    const { ports } = createTestPorts({ exec: { run: async () => exited(0) } });
    const cache = new MemCache();
    const once = async (lint: string[], notes: string) => {
      const graph = new Graph<Ports>();
      for (const name of lint)
        addCommand(graph, { name, cmd: ["lint"], inputs: { version: "lint-v1" } });
      task(graph, { name: notes, inputs: { version: "notes-v1" }, action: ({ log }) => log("x") });
      const results = await executeUnder(graph, ports, cache);
      return Object.fromEntries(results.map((r) => [r.name, r.status]));
    };
    assert.deepEqual(
      [await once(["lint"], "notes"), await once(["lint", "lint:copy"], "notes:renamed")],
      [
        { lint: "done", notes: "done" },
        { lint: "cached", "lint:copy": "cached", "notes:renamed": "done" },
      ],
    );
  });

  test("is refused when it declares an output that is not a file in its output directory", () => {
    const declaring = (report: string) => () =>
      task(new Graph<Ports>(), { name: "x", outputs: { report }, action: async () => {} });
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
});
