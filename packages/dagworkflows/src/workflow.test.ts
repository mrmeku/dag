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
        const a = workflow.task({ name: "a", cmd: ["x"], concurrencyGroup: "heavy" });
        // @ts-expect-error "light" is not a declared concurrency group
        const b = workflow.task({ name: "b", cmd: ["y"], concurrencyGroup: "light", deps: { a } });
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
  // @ts-expect-error a post's dep whose role is out
  workflow.post({ name: "q", main: pack, deps: { out: tests }, cmd: ["x"] });
  // @ts-expect-error a post's dep whose role is main, which its functions get as main's outputs
  workflow.post({ name: "r", main: pack, deps: { main: tests }, cmd: ["x"] });
}

/** Typechecked, never run: each line marked @ts-expect-error must not compile. */
export function wrongFormsAndPostsDoNotCompile(workflow: Workflow) {
  const db = workflow.task({ name: "up:db", cmd: ["db", "start"], outputs: { id: "id" } });
  // @ts-expect-error both action and cmd
  workflow.task({ name: "a", action: () => {}, cmd: ["x"] });
  // @ts-expect-error both action and shell
  workflow.task({ name: "b", action: () => {}, shell: "x" });
  // @ts-expect-error both cmd and shell
  workflow.task({ name: "c", cmd: ["x"], shell: "x" });
  // @ts-expect-error neither action, cmd nor shell
  workflow.task({ name: "d" });
  // @ts-expect-error a post with both cmd and shell
  workflow.post({ name: "e", main: db, cmd: ["x"], shell: "x" });
  // @ts-expect-error a post with inputs: it is never cached
  workflow.post({ name: "f", main: db, cmd: ["x"], inputs: { version: "f-v1" } });
  // @ts-expect-error a post with cacheable
  workflow.post({ name: "g", main: db, cmd: ["x"], cacheable: true });
  // @ts-expect-error a post with invalidateOn
  workflow.post({ name: "h", main: db, cmd: ["x"], invalidateOn: { main: () => "" } });
  // @ts-expect-error a post with no main
  workflow.post({ name: "i", cmd: ["x"] });
  const down = workflow.post({
    name: "down:db",
    main: settled(db),
    shell: 'if [ -f "$ID" ]; then docker rm -f "$(cat "$ID")"; fi',
    env: ({ main }) => ({ ID: main.id }),
  });
  // @ts-expect-error a settled main's output as an argument: it may be missing
  workflow.post({ name: "j", main: settled(db), cmd: ({ main }) => ["db", "stop", main.id] });
  workflow.post({ name: "k", main: db, cmd: ({ main }) => ["db", "stop", main.id] });
  workflow.post({
    name: "l",
    main: settled(db),
    action: async ({ depOutputs }) => void (await depOutputs.main?.id.text()),
  });
  workflow.post({
    name: "m",
    main: settled(db),
    // @ts-expect-error under settled, an action's main may be undefined
    action: async ({ depOutputs }) => void (await depOutputs.main.id.text()),
  });
  // A post of a post.
  workflow.post({ name: "report", main: down, cmd: ["report"] });
  // @ts-expect-error a post as a task's dep
  workflow.task({ name: "n", deps: { down }, cmd: ["x"] });
  // @ts-expect-error a post as another post's dep
  workflow.post({ name: "o", main: db, deps: { down }, cmd: ["x"] });
  // @ts-expect-error a post in requireAll
  workflow.requireAll({ deps: { down } });
  // @ts-expect-error a post as an upload's dep
  workflow.uploadArtifact({ name: "p", artifact: "p", path: ["x"], deps: { down } });
  // @ts-expect-error a post's dep in a role of its waits
  workflow.post({ name: "q", main: db, deps: { "downstream:e2e": db }, cmd: ["x"] });
  const cas = workflow.restoreCache({ name: "restore:cas", path: [".dag/cas"], key: "cas-1" });
  const save = workflow.saveCache({ name: "save:cas", cache: cas });
  // @ts-expect-error a save as a task's dep
  workflow.task({ name: "r", deps: { save }, cmd: ["x"] });
  // @ts-expect-error a save in requireAll
  workflow.requireAll({ deps: { save } });
  workflow.post({
    name: "s",
    main: save,
    action: async ({ depOutputs, log }) => log(await depOutputs.main.text()),
  });
}
