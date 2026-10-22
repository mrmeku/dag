import { Graph } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { settled, type OutputRef } from "./index.ts";
import type { Ports } from "./ports.ts";
import { createTestPorts } from "./ports/memory.ts";
import { createWorkflow, defineWorkflow, type Workflow } from "./workflow.ts";

describe("defineWorkflow", () => {
  test("binds the facade and carries scheduler options; group names are checked against them", async () => {
    const def = defineWorkflow({
      schedulerOptions: { concurrencyLimits: { heavy: 1 } },
      implementation: (workflow) => {
        const a = workflow.run({ name: "a", cmd: ["x"], concurrencyGroup: "heavy" });
        // @ts-expect-error "light" is not a declared concurrency group
        const b = workflow.run({ name: "b", cmd: ["y"], concurrencyGroup: "light", deps: { a } });
        // @ts-expect-error a post step says what it waits for; a graph has no end of job
        workflow.post({ name: "a:post", main: a, cmd: ["z"] });
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
          ["b", ["a"], "light"],
          ["a:post", ["a"], null],
          ["require-all", ["a", "b"], null],
        ],
      },
    );
  });

  test("workflow.compose adds another workflow's nodes to this graph and returns what its implementation returns", async () => {
    const checks = defineWorkflow({
      schedulerOptions: { maxParallelism: 1, concurrencyLimits: { test: 1 } },
      implementation: (workflow) => ({
        lint: workflow.run({ name: "lint", cmd: ["lint"] }),
        unit: workflow.run({ name: "unit", cmd: ["test"], concurrencyGroup: "test" }),
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
    const lint = (workflow: Workflow) => workflow.run({ name: "lint", cmd: ["lint"] });
    const compile = (workflow: Workflow<"mix">) =>
      workflow.run({ name: "compile", cmd: ["mix"], concurrencyGroup: "mix" });
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

/** Typechecked, never run: each line marked @ts-expect-error must not compile. */
export function wrongCommandsDoNotCompile(workflow: Workflow) {
  const pack = workflow.run({ name: "pack", cmd: ["pack"], outputs: { tarball: "pkg.tgz" } });
  const tests = workflow.run({ name: "tests", cmd: ["test"], outputs: { report: "junit.xml" } });
  const maybe = tests.name === "never" ? pack : undefined;
  // @ts-expect-error a ref in a template string (TS2731)
  workflow.run({ name: "a", deps: { pack }, cmd: ({ pack }) => [`--file=${pack.tarball}`] });
  // @ts-expect-error a ref with + (TS2469)
  workflow.run({ name: "b", deps: { pack }, cmd: ({ pack }) => ["--file=" + pack.tarball] });
  workflow.run({
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
  workflow.run({ name: "f", deps: { tests: settled(tests) }, cmd: ({ tests }) => [tests.report] });
  workflow.runShell({
    name: "g",
    deps: { tests: settled(tests) },
    cmd: 'if [ -n "$REPORT" ]; then cat "$REPORT"; fi',
    env: ({ tests }) => ({ REPORT: tests.report }),
  });
  // @ts-expect-error a node in the plain form: a ref comes only from the function's argument
  workflow.run({ name: "h", deps: { pack }, cmd: ["npm", "publish", pack] });
  // @ts-expect-error a node's ref in runShell's string (TS2731)
  workflow.runShell({ name: "k", deps: { pack }, cmd: `tar -xzf ${pack}` });
  workflow.run({
    name: "w1",
    outputs: { x: "x.txt" },
    cmd: ({ out }) => {
      // @ts-expect-error a command's own out, carried into another command
      workflow.run({ name: "w2", cmd: () => ["cat", out.x] });
      return ["touch", out.x];
    },
  });
  workflow.run({
    name: "w3",
    deps: { pack },
    cmd: (refs) => {
      // @ts-expect-error a dep's ref, carried into another command
      workflow.run({ name: "w4", deps: { pack }, cmd: () => ["cat", refs.pack.tarball] });
      return ["x"];
    },
  });
  let kept: OutputRef<string> | undefined;
  workflow.run({ name: "w5", deps: { pack }, cmd: ({ pack }) => ((kept = pack.tarball), ["x"]) });
  // @ts-expect-error a dep's ref kept in a variable and used by another command
  workflow.run({ name: "w6", deps: { pack }, cmd: () => ["cat", kept ?? "x"] });
  workflow.runShell({
    name: "k2",
    deps: { pack },
    cmd: 'eval "$UNPACK"',
    // @ts-expect-error a received ref inside a template string (TS2731)
    env: ({ pack }) => ({ UNPACK: `tar -xzf ${pack.tarball}` }),
  });
  workflow.run({
    name: "n",
    deps: { pack: maybe },
    // @ts-expect-error a dep that may be undefined, used without a check
    cmd: ({ pack }) => ["npm", "publish", pack.tarball],
  });
  workflow.run({
    name: "o",
    deps: { pack: maybe },
    cmd: ({ pack }) => ["npm", "publish", ...(pack ? [pack.tarball] : [])],
  });
  // @ts-expect-error an output named in O but not declared in outputs, so out.notes would be no file
  workflow.task<Record<never, never>, "notes">({ name: "p", action: ({ out }) => void out.notes });
  // @ts-expect-error the same for a command
  workflow.run<Record<never, never>, "x">({ name: "p2", cmd: ({ out }) => ["touch", out.x] });
  // @ts-expect-error an input named declaredOutputs, which keys a task's outputs
  workflow.task({ name: "t", inputs: { declaredOutputs: "x" }, action: () => {} });
  // @ts-expect-error an input named command, which keys a command's cmd, cwd and env
  workflow.run({ name: "u", inputs: { command: "x" }, cmd: ["x"] });
  // @ts-expect-error a dep whose role is out
  workflow.run({ name: "l", deps: { out: pack }, cmd: ["x"] });
  // @ts-expect-error a dep whose role is outputDir
  workflow.run({ name: "m", deps: { outputDir: pack }, cmd: ["x"] });
  // @ts-expect-error a post's dep whose role is out
  workflow.post({ name: "q", main: pack, deps: { out: tests }, cmd: ["x"] });
  // @ts-expect-error a post's dep whose role is main, which its functions get as main's outputs
  workflow.post({ name: "r", main: pack, deps: { main: tests }, cmd: ["x"] });
}
