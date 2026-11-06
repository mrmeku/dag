import {
  file,
  settled,
  type DepRecord,
  type FileInput,
  type Graph,
  type InputRecord,
  type NodeRef,
  type ThrottledSchedulerOptions,
} from "@mrmeku/dagraph";
import { addCache, type ActionsCacheSpec, type ActionsCacheTasks } from "../actions-cache/index.ts";
import { DEFAULT_CACHE_DIR, DEFAULT_DURATIONS_DIR } from "../config/index.ts";
import type { SummaryRenderer } from "../github-step-summary/index.ts";
import type { CiContext } from "../host/index.ts";
import type { RunReport } from "../run-store/index.ts";
import {
  addTask,
  type ActionTaskSpec as TasksActionTaskSpec,
  type PostField as TasksPostField,
  type PostSpec as TasksPostSpec,
  type TaskSpec as TasksTaskSpec,
} from "../tasks/index.ts";
import {
  addUpload,
  withDefaultExcludes,
  type UploadArtifactSpec,
} from "../upload-artifact/index.ts";
import type { Ports, WorkflowPorts } from "./ports.ts";

export { file, settled } from "@mrmeku/dagraph";
export type { Ports, WorkflowFileSystem, WorkflowPorts } from "./ports.ts";

/** What `workflow.task` takes: see `addTask`'s `TaskSpec`. Its action reads `Ports`. */
export type TaskSpec<
  G extends string,
  D extends DepRecord,
  O extends string,
  I extends InputRecord = Record<never, never>,
  P extends Ports = Ports,
> = TasksTaskSpec<G, D, O, I, P>;

/** A task whose work is an `action`, which reads `Ports`: see `TaskSpec`. */
export type ActionTaskSpec<
  G extends string,
  D extends DepRecord,
  O extends string,
  I extends InputRecord = Record<never, never>,
  P extends Ports = Ports,
> = TasksActionTaskSpec<G, D, O, I, P>;

/** A task's `post`, whose action reads `Ports`. */
export type PostSpec<O extends string = string, P extends Ports = Ports> = TasksPostSpec<O, P>;

/** A task's `post` field, or none. */
export type PostField<O extends string, P extends Ports = Ports> = TasksPostField<O, P>;

/** The run's cache and durations dirs, for a `workflow.cache` with no `path`. */
export interface RunDataPaths {
  cacheDir: string;
  durationsDir?: string | undefined;
}

/** An implementation adds nodes to the graph; the ref/event come in `ctx` for conditionals. */
export type Implementation<R = unknown> = (
  graph: Graph<Ports>,
  ports: Ports,
  ctx: CiContext,
  runDataPaths?: RunDataPaths,
) => Promise<R>;

/** The concurrency groups that scheduler options declare, or `never` when they declare none. */
export type GroupsOf<S> = S extends { concurrencyLimits: infer C }
  ? Extract<keyof C, string>
  : never;

/**
 * The required-check: an `action` task with a settled dep on every node in `deps`, so it runs
 * even when some fail (GitHub's `if: always()`), and fails itself if any of them did not produce
 * a result. `deps` is a record like every other node's, keyed by the role each check plays.
 * Its `outcome`, `require-all.json`, lists the roles `present` and `missing`.
 */
export function requireAll(
  graph: Graph<Ports>,
  opts: { name?: string; deps: Record<string, NodeRef> },
): NodeRef<Record<"outcome", string>> {
  const roles = Object.keys(opts.deps).sort();
  return addTask(graph, {
    name: opts.name ?? "require-all",
    deps: Object.fromEntries(Object.entries(opts.deps).map(([role, ref]) => [role, settled(ref)])),
    inputs: { version: "require-all:v1" },
    outputs: { outcome: "require-all.json" },
    action: async ({ depOutputs, out, ports }) => {
      const present = roles.filter((role) => depOutputs[role] !== undefined);
      const missing = roles.filter((role) => depOutputs[role] === undefined);
      await ports.fs.writeText(out.outcome, JSON.stringify({ present, missing }, null, 2));
      if (missing.length > 0) throw new Error(`failed: ${missing.join(", ")}`);
    },
  });
}

/**
 * What an implementation adds its nodes through, bound to one graph, ports and CI context.
 * - A helper that sets `concurrencyGroup: "mix"` takes `Workflow<"mix">`; one that sets no group
 *   takes `Workflow`.
 */
export interface Workflow<G extends string = never> {
  graph: Graph<Ports>;
  ports: WorkflowPorts;
  ctx: CiContext;
  /**
   * The files the patterns match as `actions/cache`'s `path:` does, less `DEFAULT_EXCLUDES`, as
   * `file()` inputs: `inputs: { version: "lint-v1", ...(await workflow.glob("src/**")) }`.
   * - Start a pattern at the directory it needs, `src/**`: a negation filters but does not prune,
   *   so `**` walks `node_modules` too.
   */
  glob: (...patterns: string[]) => Promise<Record<string, FileInput>>;
  /** GitHub's `hashFiles()` of the patterns: one hash over the matched files' contents, for a cache key. */
  hash: (...patterns: string[]) => Promise<string>;
  /**
   * Adds a node whose work is `action`, `cmd` or `shell`, and its `post` when it gives one: see
   * `TaskSpec`. `workflow.task({ name: "lint", cmd: ["bun", "run", "lint"], inputs: src })`;
   * `workflow.task({ name: "up:db", cmd: ["compose", "up"], post: { name: "down:db", cmd:
   * ["compose", "down"] } })`.
   */
  task: <
    D extends DepRecord = Record<never, never>,
    O extends string = never,
    I extends InputRecord = Record<never, never>,
  >(
    spec: TaskSpec<G, D, O, I>,
  ) => NodeRef<Record<O, string>>;
  requireAll: (opts: Parameters<typeof requireAll>[1]) => NodeRef<Record<"outcome", string>>;
  /**
   * `actions/cache` as tasks: adds the restore, `restore:<name>`, and returns it with `save`,
   * which adds the save, `save:<name>`, after every other node: see `ActionsCacheTasks`.
   * `const cache = workflow.cache({ key, restoreKeys })`, then `deps: { cache: cache.restore }`
   * and `cache.save()`.
   */
  cache: (spec: ActionsCacheSpec) => ActionsCacheTasks;
  /** `actions/upload-artifact` as a node: globs and dep outputs up as one artifact of the run. */
  uploadArtifact: <D extends DepRecord = Record<never, never>>(
    spec: UploadArtifactSpec<D>,
  ) => NodeRef<Record<"response", string>>;
  /**
   * Adds another workflow's nodes to this graph and returns what its implementation returns:
   * `const { lint } = await workflow.compose(checks)`. Its `schedulerOptions` do not apply, so
   * this workflow must declare every concurrency group the other declares.
   */
  compose: <R>(other: WorkflowDef<R, G>) => Promise<R>;
}

export function createWorkflow<G extends string>(
  graph: Graph<Ports>,
  ports: Ports,
  ctx: CiContext,
  runDataPaths: RunDataPaths = { cacheDir: DEFAULT_CACHE_DIR },
): Workflow<G> {
  const { cacheDir, durationsDir = DEFAULT_DURATIONS_DIR } = runDataPaths;
  return {
    graph,
    ports,
    ctx,
    glob: async (...patterns) =>
      Object.fromEntries(
        (patterns.length ? await ports.fileMatcher.match(withDefaultExcludes(patterns)) : []).map(
          (path) => [path, file(path)],
        ),
      ),
    hash: (...patterns) => ports.fileMatcher.hash(patterns),
    task: (spec) => addTask(graph, spec),
    requireAll: (opts) => requireAll(graph, opts),
    cache: (spec) => addCache(graph, spec, { cacheDir, durationsDir, runId: ctx.runId }),
    uploadArtifact: (spec) => addUpload(graph, spec),
    compose: (other) => other.implementation(graph, ports, ctx, runDataPaths),
  };
}

const WORKFLOW_DEF: unique symbol = Symbol.for("@mrmeku/dagworkflows/WorkflowDef");

/** A workflow, as `defineWorkflow` returns it. */
export interface WorkflowDef<R = unknown, G extends string = string> {
  readonly [WORKFLOW_DEF]: true;
  implementation: Implementation<R>;
  schedulerOptions?: ThrottledSchedulerOptions;
  summary?: readonly SummaryRenderer<RunReport>[];
  /** The concurrency groups it declares, for `workflow.compose`'s check; never set. */
  readonly _groups?: G;
}

/** Whether a value carries `defineWorkflow`'s stamp, from this copy of the package or another. */
const isWorkflowDef = (value: unknown): value is WorkflowDef =>
  typeof value === "object" && value !== null && WORKFLOW_DEF in value;

/** The workflow a workflow file's module default-exports; refused when it exports none. */
export function workflowOf(module: unknown, file: string): WorkflowDef {
  const def =
    typeof module === "object" && module !== null && "default" in module && module.default;
  if (!isWorkflowDef(def))
    throw new Error(`${file} default-exports no workflow: export default defineWorkflow({ ... })`);
  return def;
}

/**
 * Declares a workflow, what a workflow file default-exports:
 * `export default defineWorkflow({ implementation: (workflow) => { ... } })`. `summary` defaults
 * to `DEFAULT_SUMMARY_RENDERERS`.
 */
export function defineWorkflow<S extends ThrottledSchedulerOptions, R = void>(def: {
  schedulerOptions?: S;
  summary?: readonly SummaryRenderer<RunReport>[];
  implementation: (workflow: Workflow<GroupsOf<S>>) => R | Promise<R>;
}): WorkflowDef<R, GroupsOf<S>> {
  return {
    [WORKFLOW_DEF]: true,
    ...(def.schedulerOptions && { schedulerOptions: def.schedulerOptions }),
    ...(def.summary && { summary: def.summary }),
    implementation: async (graph, ports, ctx, runDataPaths) =>
      def.implementation(createWorkflow<GroupsOf<S>>(graph, ports, ctx, runDataPaths)),
  };
}
