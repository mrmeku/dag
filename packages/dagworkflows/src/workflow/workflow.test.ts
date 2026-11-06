import {
  execute,
  file,
  Graph,
  namedOutput,
  type ExecutionContext,
  type NodeResult,
  type OutputRef,
} from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { matchesGlob } from "node:path";
import { describe, test } from "node:test";
import { memoryRuntime } from "../memory/index.ts";
import {
  createMemoryArtifactStore,
  createMemoryCacheStore,
  createRecordingHost,
  type MemoryCacheStore,
} from "../recording/index.ts";
import type { FileMatcher } from "../upload-artifact/index.ts";
import {
  createWorkflow,
  defineWorkflow,
  settled,
  workflowOf,
  type ActionTaskSpec,
  type Ports,
  type PostSpec,
  type RunDataPaths,
  type Workflow,
} from "./index.ts";

/**
 * Ports of doubles: a fresh memory runtime's members, the recording host and memory stores, and
 * the runtime's file matcher unless given one.
 */
function portsOf(fileMatcher?: FileMatcher): Ports & { cacheStore: MemoryCacheStore } {
  const runtime = memoryRuntime();
  return {
    exec: runtime.exec,
    fs: runtime.fs,
    clock: runtime.clock,
    startTimer: runtime.startTimer,
    host: createRecordingHost().host,
    cacheStore: createMemoryCacheStore(),
    artifactStore: createMemoryArtifactStore(),
    lockfile: runtime.lockfile,
    fileMatcher: fileMatcher ?? runtime.fileMatcher,
    env: runtime.env,
  };
}

/**
 * A matcher over `files` with the glob grammar's negation: the files a pattern matches and no `!`
 * pattern does, sorted; its hash names the files it hashes.
 */
function globMatcher(files: string[]): FileMatcher {
  const match = async (patterns: string[]) => {
    const excluded = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
    const included = patterns.filter((p) => !p.startsWith("!"));
    return files
      .filter((f) => included.some((p) => matchesGlob(f, p)))
      .filter((f) => !excluded.some((p) => matchesGlob(f, p)))
      .sort();
  };
  return { match, hash: async (patterns) => (await match(patterns)).join(" ") };
}

/** A fresh graph and the workflow over it, with the run's data paths when given. */
async function workflowOver(ports: Ports, runDataPaths?: RunDataPaths) {
  const graph = new Graph<Ports>();
  return {
    graph,
    workflow: createWorkflow(graph, ports, await ports.host.context(), runDataPaths),
  };
}

/** dagraph's execution context over the ports, its cache in `/cache`. */
const contextOf = (ports: Ports): ExecutionContext<Ports> => ({
  ports,
  fs: ports.fs,
  cacheDir: "/cache",
  clock: ports.clock,
  startTimer: ports.startTimer,
});

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
    const ports = portsOf();
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
    const { graph, workflow } = await workflowOver(portsOf());
    const returned = await workflow.compose(ci);
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

  test("a composed workflow's cache with no path saves this run's data dirs", async () => {
    const cacheWorkflow = defineWorkflow({
      implementation: (workflow) => workflow.cache({ key: "k" }).save(),
    });
    const ports = portsOf();
    const { graph, workflow } = await workflowOver(ports, {
      cacheDir: "/run/cache",
      durationsDir: "/run/durations",
    });
    await workflow.compose(cacheWorkflow);
    await execute(graph, contextOf(ports));
    assert.deepEqual(
      ports.cacheStore.savedCaches,
      new Map([["k", ["/run/cache", "/run/durations"]]]),
    );
  });

  test("workflow.glob gives the matched files less the default excludes as file() inputs, and workflow.hash hashes its patterns as they are", async () => {
    const files = ["src/b.ts", "src/node_modules/x.js", "src/a.ts"];
    const { workflow } = await workflowOver(portsOf(globMatcher(files)));
    assert.deepEqual(
      { glob: await workflow.glob("src/**"), hash: await workflow.hash("src/**") },
      {
        glob: { "src/a.ts": file("src/a.ts"), "src/b.ts": file("src/b.ts") },
        hash: "src/a.ts src/b.ts src/node_modules/x.js",
      },
    );
  });

  test("workflowOf takes a module's default export when it carries the stamp, from any copy of the package, and refuses one that exports no workflow", () => {
    const def = defineWorkflow({ implementation: () => {} });
    const fromAnotherCopy: object = {
      [Symbol.for("@mrmeku/dagworkflows/WorkflowDef")]: true,
      implementation: async () => {},
    };
    const refusalOf = (module: unknown) => {
      try {
        workflowOf(module, "ci.ts");
        return "taken";
      } catch (e) {
        return e instanceof Error ? e.message : e;
      }
    };
    assert.deepEqual(
      {
        def: workflowOf({ default: def }, "ci.ts") === def,
        fromAnotherCopy: workflowOf({ default: fromAnotherCopy }, "ci.ts") === fromAnotherCopy,
        named: refusalOf({ workflow: def }),
        plain: refusalOf({ default: { implementation: async () => {} } }),
      },
      {
        def: true,
        fromAnotherCopy: true,
        named: "ci.ts default-exports no workflow: export default defineWorkflow({ ... })",
        plain: "ci.ts default-exports no workflow: export default defineWorkflow({ ... })",
      },
    );
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

describe("requireAll", () => {
  test("writes which roles succeeded and which did not, succeeding when all did and failing with the missing roles otherwise", async () => {
    const ports = portsOf();
    const { graph, workflow } = await workflowOver(ports);
    const pass = workflow.task({ name: "pass", action: () => {} });
    const fail = workflow.task({
      name: "fail",
      action: () => {
        throw new Error("boom");
      },
    });
    workflow.requireAll({ name: "all-green", deps: { pass } });
    workflow.requireAll({ deps: { pass, fail } });
    const results = await execute(graph, contextOf(ports));
    const settledAs = async (result: NodeResult | undefined): Promise<unknown> => {
      if (result?.status === "failed") return result.error.message;
      if (result?.status !== "succeeded") return result?.status;
      return JSON.parse(
        await ports.fs.readText(namedOutput(result.details.entry.outputs, "outcome")),
      );
    };
    assert.deepEqual(
      {
        green: await settledAs(results.find((r) => r.name === "all-green")),
        red: await settledAs(results.find((r) => r.name === "require-all")),
      },
      { green: { present: ["pass"], missing: [] }, red: "failed: fail" },
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
  const cacheDir = workflow.cache({ name: "cache-dir", path: [".dag/cache"], key: "cache-dir-1" });
  cacheDir.save({ partial: "skip" });
  // @ts-expect-error a save with cacheable: it is never cached
  cacheDir.save({ cacheable: true });
}

/** Typechecked, never run: a spec typed with the package's names reads every port but exec. */
export function specTypesReadThePorts(workflow: Workflow) {
  const report: ActionTaskSpec<never, Record<never, never>, never> = {
    name: "report",
    action: ({ ports }) => ports.host.info(ports.env.CI ?? "local"),
  };
  const down: PostSpec<"id"> = {
    name: "down:db",
    action: ({ ports }) => ports.host.info(ports.env.DB_HOST ?? "localhost"),
  };
  workflow.task(report);
  workflow.task({ name: "up:db", cmd: ["db", "start"], outputs: { id: "id" }, post: down });
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
