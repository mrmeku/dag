import { Graph, type Outputs } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { logPath, runWorkflow, settled, type OutputRef } from "./index.ts";
import type { Ports } from "./ports.ts";
import { createTestPorts } from "./ports/memory.ts";
import type { PostSpec } from "./post.ts";
import { createWorkflow, defineWorkflow, type Workflow } from "./workflow.ts";

describe("defineWorkflow", () => {
  test("binds the facade and carries scheduler options; group names are checked against them", async () => {
    const def = defineWorkflow({
      schedulerOptions: { concurrencyLimits: { heavy: 1 } },
      implementation: (workflow) => {
        const a = workflow.task({
          name: "a",
          cmd: ["x"],
          concurrencyGroup: "heavy",
          post: { name: "a:post", cmd: ["z"] },
        });
        // @ts-expect-error "light" is not a declared concurrency group
        const b = workflow.task({ name: "b", cmd: ["y"], concurrencyGroup: "light", deps: { a } });
        workflow.requireAll({ deps: { a, b } });
      },
    });
    const { ports } = createTestPorts();
    const graph = new Graph<Ports>();
    await def.implementation(graph, ports, await ports.host.context());
    assert.deepEqual(
      {
        schedulerOptions: def.schedulerOptions,
        nodes: graph.describe().map((n) => [n.name, n.deps, n.concurrencyGroup ?? null]),
      },
      {
        schedulerOptions: { concurrencyLimits: { heavy: 1 } },
        nodes: [
          ["a", [], "heavy"],
          ["a:post", ["a"], null],
          ["b", ["a"], "light"],
          ["require-all", ["a", "b"], null],
        ],
      },
    );
  });

  test("workflow.compose adds another workflow's nodes to this graph and returns what its implementation returns", async () => {
    const checks = defineWorkflow({
      schedulerOptions: { maxParallelism: 1, concurrencyLimits: { test: 1 } },
      implementation: (workflow) => ({
        lint: workflow.task({ name: "lint", cmd: ["lint"] }),
        unit: workflow.task({ name: "unit", cmd: ["test"], concurrencyGroup: "test" }),
      }),
    });
    const ci = defineWorkflow({
      schedulerOptions: { concurrencyLimits: { test: 2, browser: 1 } },
      implementation: async (workflow) => {
        const { lint, unit } = await workflow.compose(checks);
        return workflow.requireAll({ deps: { lint, unit } }).name;
      },
    });
    const { ports } = createTestPorts();
    const graph = new Graph<Ports>();
    const returned = await createWorkflow(graph, ports, await ports.host.context()).compose(ci);
    assert.deepEqual(
      {
        returned,
        nodes: graph.describe().map((n) => [n.name, n.deps, n.concurrencyGroup ?? null]),
      },
      {
        returned: "require-all",
        nodes: [
          ["lint", [], null],
          ["unit", [], "test"],
          ["require-all", ["lint", "unit"], null],
        ],
      },
    );
  });

  test("workflow.glob leaves out the directories in DEFAULT_EXCLUDES, and workflow.hash passes its patterns to hashFiles() as they are", async () => {
    mkdirSync(".dag", { recursive: true });
    const dir = mkdtempSync(join(".dag", "hash-test-"));
    try {
      writeFileSync(join(dir, "a.txt"), "a");
      const { ports } = createTestPorts();
      const workflow = createWorkflow(new Graph<Ports>(), ports, await ports.host.context());
      const { hashFiles } = await import("@actions/glob");
      const hashed = await workflow.hash(`${dir}/**`);
      assert.deepEqual(
        {
          globbed: await workflow.glob(`${dir}/**`),
          hashed: hashed !== "" && hashed === (await hashFiles(`${dir}/**`)),
        },
        { globbed: {}, hashed: true },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Checked by the typecheck: a call that does not compile fails it, as the @ts-expect-error does
  // if the call compiles. Building the graphs would repeat what the test above asserts.
  test("a builder typed Workflow takes the facade of any workflow; one that uses a group takes only a workflow that declares it, and compose takes only a workflow whose groups this one declares", () => {
    const lint = (workflow: Workflow) => workflow.task({ name: "lint", cmd: ["lint"] });
    const compile = (workflow: Workflow<"mix">) =>
      workflow.task({ name: "compile", cmd: ["mix"], concurrencyGroup: "mix" });
    const browsers = defineWorkflow({
      schedulerOptions: { concurrencyLimits: { browser: 1 } },
      implementation: () => {},
    });
    defineWorkflow({ implementation: (workflow) => void lint(workflow) });
    defineWorkflow({
      schedulerOptions: { concurrencyLimits: { mix: 1, browser: 1 } },
      implementation: async (workflow) =>
        void [lint(workflow), compile(workflow), await workflow.compose(browsers)],
    });
    defineWorkflow({
      schedulerOptions: { concurrencyLimits: { browser: 1 } },
      // @ts-expect-error a builder that uses a group the workflow does not declare
      implementation: (workflow) => compile(workflow),
    });
    defineWorkflow({
      schedulerOptions: { concurrencyLimits: { mix: 1 } },
      // @ts-expect-error a composed workflow whose group this one does not declare
      implementation: (workflow) => workflow.compose(browsers),
    });
  });
});

describe("two of every node the facade adds", () => {
  test("that differ in their work each have a key, a log and outputs of their own", async () => {
    // A command prints its last argument, so its log shows which command ran.
    const { ports, fs, cacheStore } = createTestPorts({
      exec: {
        run: async (argv) => {
          const output = `${argv.at(-1) ?? ""}\n`;
          return { ended: "exited", code: 0, stdout: output, stderr: "", output, ok: true };
        },
      },
    });
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        for (const x of ["a", "b"]) {
          workflow.cache({ name: x, path: [x], key: `${x}-1`, restoreKeys: [`${x}-`] }).save();
          const cmd = workflow.task({ name: `cmd:${x}`, cmd: ["echo", `cmd ${x}`] });
          workflow.task({ name: `shell:${x}`, shell: `echo shell ${x}` });
          const action = workflow.task({
            name: `action:${x}`,
            outputs: { note: "note.txt" },
            action: async ({ out, ports: p, log }) => {
              log(`action ${x}`);
              await p.fs.writeText(out.note, x);
            },
          });
          workflow.uploadArtifact({
            name: `upload:${x}`,
            artifact: x,
            deps: { action },
            path: ({ action }) => [action.note],
          });
          workflow.requireAll({ name: `require:${x}`, deps: { [x]: cmd } });
          workflow.task({
            name: `up:${x}`,
            cmd: ["echo", `up ${x}`],
            post: { name: `down:${x}`, action: ({ log }) => log(`down ${x}`) },
          });
          workflow.task({
            name: `start:${x}`,
            cmd: ["echo", `start ${x}`],
            post: { name: `stop:${x}`, cmd: ["echo", `stop ${x}`] },
          });
          workflow.task({
            name: `make:${x}`,
            cmd: ["echo", `make ${x}`],
            post: { name: `clean:${x}`, shell: `echo clean ${x}` },
          });
        }
      },
    });
    const { results } = await runWorkflow({
      implementation,
      ports,
      casBaseDir: "/cas",
      historyDir: "/state/history",
    });
    const read = async (outputs: Outputs): Promise<unknown> =>
      typeof outputs === "string"
        ? JSON.parse(await fs.readText(outputs))
        : Object.fromEntries(
            await Promise.all(
              Object.entries(outputs).map(async ([role, path]) => [
                role,
                typeof path === "string" ? await fs.readText(path) : path,
              ]),
            ),
          );
    const nodes = Object.fromEntries(
      await Promise.all(
        results.map(async (result): Promise<[string, unknown]> => {
          const log = logPath("/cas", result.actionKey);
          return [
            result.name,
            {
              status: result.status,
              ownKey: results.filter((other) => other.actionKey === result.actionKey).length === 1,
              log: (await fs.exists(log)) ? await fs.readText(log) : null,
              outputs: result.status === "done" ? await read(result.outputs) : null,
            },
          ];
        }),
      ),
    );
    const node = (log: string | null, outputs: unknown) => ({
      status: "done",
      ownKey: true,
      log,
      outputs,
    });
    const pair = (x: string, id: number) => ({
      [`restore:${x}`]: node(`Cache not found for input keys: ${x}-1, ${x}-\n`, {}),
      [`save:${x}`]: node(`Cache saved with key: ${x}-1\n`, { saved: "true" }),
      [`cmd:${x}`]: node(`cmd ${x}\n`, {}),
      [`shell:${x}`]: node(`echo shell ${x}\n`, {}),
      [`action:${x}`]: node(`action ${x}\n`, { note: x }),
      [`upload:${x}`]: node(
        `Artifact ${x} has been successfully uploaded! Final size is 1 bytes. Artifact ID is ${id}\n`,
        { response: JSON.stringify({ id, size: 1 }, null, 2) },
      ),
      [`require:${x}`]: node("", {
        outcome: JSON.stringify({ present: [x], missing: [] }, null, 2),
      }),
      [`up:${x}`]: node(`up ${x}\n`, {}),
      [`start:${x}`]: node(`start ${x}\n`, {}),
      [`make:${x}`]: node(`make ${x}\n`, {}),
      [`down:${x}`]: node(`down ${x}\n`, {}),
      [`stop:${x}`]: node(`stop ${x}\n`, {}),
      [`clean:${x}`]: node(`echo clean ${x}\n`, {}),
    });
    assert.deepEqual(
      { nodes, saved: Object.fromEntries(cacheStore.entries) },
      {
        nodes: { ...pair("a", 1), ...pair("b", 2) },
        saved: { "a-1": ["a"], "b-1": ["b"] },
      },
    );
  });
});

/** Typechecked, never run: each line marked @ts-expect-error must not compile. */
export function wrongCommandsDoNotCompile(workflow: Workflow) {
  const pack = workflow.task({ name: "pack", cmd: ["pack"], outputs: { tarball: "pkg.tgz" } });
  const tests = workflow.task({ name: "tests", cmd: ["test"], outputs: { report: "junit.xml" } });
  const maybe = tests.name === "never" ? pack : undefined;
  // @ts-expect-error a ref in a template string (TS2731)
  workflow.task({ name: "a", deps: { pack }, cmd: ({ pack }) => [`--file=${pack.tarball}`] });
  // @ts-expect-error a ref with + (TS2469)
  workflow.task({ name: "b", deps: { pack }, cmd: ({ pack }) => ["--file=" + pack.tarball] });
  workflow.task({
    name: "c",
    deps: { pack },
    outputs: { x: "x.txt" },
    cmd: (refs) => {
      // @ts-expect-error a ref's toString (TS2349)
      void refs.pack.tarball.toString();
      // @ts-expect-error an output of a dep the node did not declare: "Property 'tests' does not exist"
      void refs.tests;
      // @ts-expect-error a command's own ref is not an engine ref: "Property 'node' does not exist"
      void refs.out.x.node;
      // @ts-expect-error a misspelt output: "Did you mean 'tarball'?"
      void refs.pack.tarbal;
      return ["npm", "publish", refs.pack.tarball];
    },
  });
  // @ts-expect-error a settled dep's output as an argument: not assignable
  workflow.task({ name: "f", deps: { tests: settled(tests) }, cmd: ({ tests }) => [tests.report] });
  workflow.task({
    name: "g",
    deps: { tests: settled(tests) },
    shell: 'if [ -n "$REPORT" ]; then cat "$REPORT"; fi',
    env: ({ tests }) => ({ REPORT: tests.report }),
  });
  // @ts-expect-error a node in the plain form: a ref comes only from the function's argument
  workflow.task({ name: "h", deps: { pack }, cmd: ["npm", "publish", pack] });
  // @ts-expect-error a node's ref in a shell string (TS2731)
  workflow.task({ name: "k", deps: { pack }, shell: `tar -xzf ${pack}` });
  workflow.task({
    name: "w1",
    outputs: { x: "x.txt" },
    cmd: ({ out }) => {
      // @ts-expect-error a command's own out, carried into another command
      workflow.task({ name: "w2", cmd: () => ["cat", out.x] });
      return ["touch", out.x];
    },
  });
  workflow.task({
    name: "w3",
    deps: { pack },
    cmd: (refs) => {
      // @ts-expect-error a dep's ref, carried into another command
      workflow.task({ name: "w4", deps: { pack }, cmd: () => ["cat", refs.pack.tarball] });
      return ["x"];
    },
  });
  let kept: OutputRef<string> | undefined;
  workflow.task({ name: "w5", deps: { pack }, cmd: ({ pack }) => ((kept = pack.tarball), ["x"]) });
  // @ts-expect-error a dep's ref kept in a variable and used by another command
  workflow.task({ name: "w6", deps: { pack }, cmd: () => ["cat", kept ?? "x"] });
  workflow.task({
    name: "k2",
    deps: { pack },
    shell: 'eval "$UNPACK"',
    // @ts-expect-error a received ref inside a template string (TS2731)
    env: ({ pack }) => ({ UNPACK: `tar -xzf ${pack.tarball}` }),
  });
  workflow.task({
    name: "n",
    deps: { pack: maybe },
    // @ts-expect-error a dep that may be undefined, used without a check
    cmd: ({ pack }) => ["npm", "publish", pack.tarball],
  });
  workflow.task({
    name: "o",
    deps: { pack: maybe },
    cmd: ({ pack }) => ["npm", "publish", ...(pack ? [pack.tarball] : [])],
  });
  // @ts-expect-error an output named in O but not declared in outputs, so out.notes would be no file
  workflow.task<Record<never, never>, "notes">({ name: "p", action: ({ out }) => void out.notes });
  // @ts-expect-error the same for a command
  workflow.task<Record<never, never>, "x">({ name: "p2", cmd: ({ out }) => ["touch", out.x] });
  // @ts-expect-error an input named declaredOutputs, which keys a task's outputs
  workflow.task({ name: "t", inputs: { declaredOutputs: "x" }, action: () => {} });
  // @ts-expect-error an input named command, which keys a command's cmd, cwd and env
  workflow.task({ name: "u", inputs: { command: "x" }, cmd: ["x"] });
  // @ts-expect-error a dep whose role is out
  workflow.task({ name: "l", deps: { out: pack }, cmd: ["x"] });
  // @ts-expect-error a dep whose role is outputDir
  workflow.task({ name: "m", deps: { outputDir: pack }, cmd: ["x"] });
}

/** Typechecked, never run: each line marked @ts-expect-error must not compile. */
export function wrongFormsAndPostsDoNotCompile(workflow: Workflow) {
  const up = (post: PostSpec<"id">) =>
    workflow.task({ name: "up:db", cmd: ["db", "start"], outputs: { id: "id" }, post });
  // @ts-expect-error both action and cmd
  workflow.task({ name: "a", action: () => {}, cmd: ["x"] });
  // @ts-expect-error both action and shell
  workflow.task({ name: "b", action: () => {}, shell: "x" });
  // @ts-expect-error both cmd and shell
  workflow.task({ name: "c", cmd: ["x"], shell: "x" });
  // @ts-expect-error neither action, cmd nor shell
  workflow.task({ name: "d" });
  // @ts-expect-error a post with both cmd and shell
  up({ name: "e", cmd: ["x"], shell: "x" });
  // @ts-expect-error a post with inputs: it is never cached
  up({ name: "f", cmd: ["x"], inputs: { version: "f-v1" } });
  // @ts-expect-error a post with cacheable
  up({ name: "g", cmd: ["x"], cacheable: true });
  up({
    name: "down:db",
    shell: 'if [ -f "$ID" ]; then docker rm -f "$(cat "$ID")"; fi',
    env: ({ main }) => ({ ID: main.id }),
  });
  // @ts-expect-error its task's output as an argument: a task that failed may not have written it
  up({ name: "j", cmd: ({ main }) => ["db", "stop", main.id] });
  up({ name: "l", action: async ({ depOutputs }) => void (await depOutputs.main?.id.text()) });
  up({
    name: "m",
    // @ts-expect-error an action's main may be undefined: its task may have failed
    action: async ({ depOutputs }) => void (await depOutputs.main.id.text()),
  });
  // @ts-expect-error a retry that is neither backoff nor once
  up({ name: "n", cmd: ["x"], retry: "forever" });
  const cas = workflow.cache({ name: "cas", path: [".dag/cas"], key: "cas-1" });
  cas.save({ partial: "skip" });
  // @ts-expect-error a save with cacheable: it is never cached
  cas.save({ cacheable: true });
}

/** Typechecked, never run: each line marked @ts-expect-error must not compile. */
export function uploadPathsReadHandles(workflow: Workflow) {
  const pack = workflow.task({ name: "pack", cmd: ["pack"], outputs: { tarball: "pkg.tgz" } });
  // The function gets each dep's outputs as the handles an action reads.
  workflow.uploadArtifact({
    name: "a",
    artifact: "a",
    deps: { pack },
    path: ({ pack }) => [pack.tarball],
  });
  workflow.uploadArtifact({
    name: "b",
    artifact: "b",
    deps: { pack: settled(pack) },
    // @ts-expect-error a settled dep that failed is undefined: check it
    path: ({ pack }) => [pack.tarball],
  });
  workflow.uploadArtifact({
    name: "c",
    artifact: "c",
    deps: { pack: settled(pack) },
    path: ({ pack }) => [pack?.tarball],
  });
}

/** Typechecked, never run: each line marked @ts-expect-error must not compile. */
export function execIsOutOfReach(workflow: Workflow) {
  // @ts-expect-error a command while the graph is built, which no node logs or cancels
  void workflow.ports.exec;
  workflow.task({
    name: "a",
    action: async ({ ports, run }) => {
      // @ts-expect-error a command past the task's shell, which its log and cancel miss
      void ports.exec;
      await run(["true"]);
    },
  });
  workflow.task({
    name: "c",
    cmd: ["true"],
    post: {
      name: "b",
      // @ts-expect-error a post's action gets the same ports
      action: ({ ports }) => void ports.exec,
    },
  });
}
