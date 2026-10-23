import {
  file,
  type DepRecord,
  type FileInput,
  type Graph,
  type InputRecord,
  type NodeRef,
  type ThrottledSchedulerOptions,
} from "@mrmeku/dagraph";
import { cache, type ActionsCacheSpec, type ActionsCacheTasks } from "./cache.ts";
import { addCommand, type CmdTaskSpec, type ShellTaskSpec } from "./commands.ts";
import type { CiContext, Ports } from "./ports.ts";
import { post, type PostSpec } from "./post.ts";
import type { Implementation } from "./runner.ts";
import {
  glob,
  hashFiles,
  requireAll,
  uploadArtifact,
  type Main,
  type PostRef,
  type UploadArtifactSpec,
} from "./steps.ts";
import type { SummaryRenderer } from "./summary.ts";
import { addTask, type ActionTaskSpec } from "./task.ts";

/**
 * What `workflow.task` takes: a node whose work is exactly one of `action`, a TypeScript function
 * (`ActionTaskSpec`); `cmd`, an argv run with no shell (`CmdTaskSpec`); or `shell`, a string
 * run under bash (`ShellTaskSpec`). Giving two does not compile.
 */
export type TaskSpec<
  G extends string,
  D extends DepRecord,
  O extends string,
  I extends InputRecord = Record<never, never>,
> = ActionTaskSpec<G, D, O, I> | CmdTaskSpec<G, D, O> | ShellTaskSpec<G, D, O>;

/** The concurrency groups that scheduler options declare, or `never` when they declare none. */
export type GroupsOf<S> = S extends { concurrencyLimits: infer C }
  ? Extract<keyof C, string>
  : never;

/**
 * What an implementation adds its nodes through, bound to one graph, ports and CI context.
 * - A helper that sets `concurrencyGroup: "mix"` takes `Workflow<"mix">`; one that sets no group
 *   takes `Workflow`.
 */
export interface Workflow<G extends string = never> {
  graph: Graph<Ports>;
  ports: Ports;
  ctx: CiContext;
  /**
   * The files the patterns match as `actions/cache`'s `path:` does, less `DEFAULT_EXCLUDES`, as
   * `file()` inputs: `inputs: { version: "lint-v1", ...(await workflow.glob("src/**")) }`.
   * - Start a pattern at the directory it needs, `src/**`: a negation filters but does not prune,
   *   so `**` walks `node_modules` too.
   */
  glob: (...patterns: string[]) => Promise<Record<string, FileInput>>;
  /** The `hashFiles()` of a workflow file: one hash over the matched files' contents, for a cache key. */
  hash: (...patterns: string[]) => Promise<string>;
  /**
   * Adds a node whose work is `action`, `cmd` or `shell`: see `TaskSpec`.
   * `workflow.task({ name: "lint", cmd: ["bun", "run", "lint"], inputs: src })`.
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
   * Adds a task that runs after `main` and every node of the run downstream of it, still owed
   * after a cancel: see `PostSpec`.
   * `workflow.post({ name: "down:db", main: settled(db), cmd: ["docker", "rm", "-f", "db"] })`.
   */
  post: <
    D extends DepRecord = Record<never, never>,
    O extends string = never,
    M extends Main = Main,
  >(
    spec: PostSpec<G, D, O, M>,
  ) => PostRef<Record<O, string>>;
  /**
   * `actions/cache` as tasks: adds the restore, `restore:<name>`, and returns it with `save`,
   * which adds the save, `save:<name>`, a post of the restore: see `ActionsCacheTasks`.
   * `const cas = workflow.cache({ name: "cas", path: [".dag/cas"], key, restoreKeys })`, then
   * `deps: { cas: cas.restore }` and `cas.save()`.
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
): Workflow<G> {
  return {
    graph,
    ports,
    ctx,
    glob: async (...patterns) =>
      Object.fromEntries((await glob(patterns)).map((path) => [path, file(path)])),
    hash: (...patterns) => hashFiles(patterns),
    task: (spec) => (spec.action === undefined ? addCommand(graph, spec) : addTask(graph, spec)),
    requireAll: (opts) => requireAll(graph, opts),
    post: (spec) => post(graph, spec),
    cache: (spec) => cache(graph, spec),
    uploadArtifact: (spec) => uploadArtifact(graph, spec),
    compose: (other) => other.implementation(graph, ports, ctx),
  };
}

export const WORKFLOW_DEF: unique symbol = Symbol.for("@mrmeku/dagworkflows/WorkflowDef");

/** A workflow, as `defineWorkflow` returns it. */
export interface WorkflowDef<R = unknown, G extends string = string> {
  readonly [WORKFLOW_DEF]: true;
  implementation: Implementation<R>;
  schedulerOptions?: ThrottledSchedulerOptions;
  summary?: readonly SummaryRenderer[];
  /** The concurrency groups it declares, for `workflow.compose`'s check; never set. */
  readonly _groups?: G;
}

/** Whether a value is what `defineWorkflow` returns, which alone carries its brand. */
const isWorkflowDef = (value: unknown): value is WorkflowDef =>
  typeof value === "object" && value !== null && WORKFLOW_DEF in value;

/** The workflow a workflow file's module default-exports; refused when it exports none. */
export function workflowDefOf(module: unknown, file: string): WorkflowDef {
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
  summary?: readonly SummaryRenderer[];
  implementation: (workflow: Workflow<GroupsOf<S>>) => R | Promise<R>;
}): WorkflowDef<R, GroupsOf<S>> {
  return {
    [WORKFLOW_DEF]: true,
    ...(def.schedulerOptions && { schedulerOptions: def.schedulerOptions }),
    ...(def.summary && { summary: def.summary }),
    implementation: async (graph, ports, ctx) =>
      def.implementation(createWorkflow<GroupsOf<S>>(graph, ports, ctx)),
  };
}
