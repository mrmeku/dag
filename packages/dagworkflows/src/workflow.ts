import {
  settled,
  type Graph,
  type NodeRef,
  type SettledRef,
  type ThrottledSchedulerOptions,
} from "@mrmeku/dagraph";
import type { CiContext, Ports } from "./ports.ts";
import type { Implementation } from "./runner.ts";
import {
  glob,
  hashFiles,
  post,
  requireAll,
  restoreCache,
  run,
  runAll,
  saveCache,
  uploadArtifact,
  type PostSpec,
  type RestoreCacheRef,
  type RestoreCacheSpec,
  type RunRef,
  type RunSpec,
  type UploadArtifactSpec,
} from "./steps.ts";
import type { SummaryRenderer } from "./summary.ts";

/** The concurrency groups that scheduler options declare, or `never` when they declare none. */
export type GroupsOf<S> = S extends { concurrencyLimits: infer C }
  ? Extract<keyof C, string>
  : never;

/**
 * The step vocabulary bound to one graph, ports and CI context, so a workflow's implementation
 * never threads them through and needs no runtime import but `defineWorkflow`. `G` is the set of
 * concurrency groups the workflow's scheduler options declare. A builder that uses no group
 * takes `Workflow`, the facade of every workflow; one that uses `group: "mix"` takes
 * `Workflow<"mix">`, and only a workflow that declares `mix` can call it.
 */
export interface Workflow<G extends string = never> {
  graph: Graph<Ports>;
  ports: Ports;
  ctx: CiContext;
  glob: (...patterns: string[]) => Promise<string[]>;
  /** The `hashFiles()` of a workflow file: one hash over the matched files' contents, for a cache key. */
  hash: (...patterns: string[]) => Promise<string>;
  run: <O extends string = never>(spec: RunSpec<G, O> & { name: string }) => RunRef<O>;
  runAll: <K extends string>(specs: Record<K, RunSpec<G>>) => Record<K, RunRef>;
  requireAll: (opts: { name?: string; deps: Record<string, NodeRef> }) => NodeRef<string>;
  /** A command as the `post:` of `main`: never cached, runs after its `deps`, and after a cancel. */
  post: <O extends string = never>(spec: PostSpec<G, O> & { name: string }) => RunRef<O>;
  /** `actions/cache/restore` as a node. */
  restoreCache: (spec: RestoreCacheSpec) => RestoreCacheRef;
  /** `actions/cache/save` as its post step; `cache` is the restore node it saves for. */
  saveCache: (opts: {
    name: string;
    cache: RestoreCacheRef;
    deps: Record<string, NodeRef | SettledRef | undefined> & { cache?: never };
  }) => NodeRef<string>;
  /** `actions/upload-artifact` as a node: globs and dep outputs up as one artifact of the run. */
  uploadArtifact: (spec: UploadArtifactSpec) => NodeRef<string>;
  /** Mark a dep the consumer runs without when it failed: GitHub's `if: always()`. */
  settled: (ref: NodeRef | RunRef<string>) => SettledRef;
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
    glob: (...patterns) => glob(patterns),
    hash: (...patterns) => hashFiles(patterns),
    run: (spec) => run(graph, spec),
    runAll: (specs) => runAll(graph, specs),
    requireAll: (opts) => requireAll(graph, opts),
    post: (spec) => post(graph, spec),
    restoreCache: (spec) => restoreCache(graph, spec),
    saveCache: (opts) => saveCache(graph, opts),
    uploadArtifact: (spec) => uploadArtifact(graph, spec),
    settled: (ref) => settled({ name: ref.name }),
  };
}

export const WORKFLOW_DEF: unique symbol = Symbol.for("@mrmeku/dagworkflows/WorkflowDef");

/**
 * What a workflow file default-exports. `R` is what the implementation returns, for a caller that
 * builds the graph itself, such as a test.
 */
export interface WorkflowDef<R = unknown> {
  readonly [WORKFLOW_DEF]: true;
  implementation: Implementation<R>;
  schedulerOptions?: ThrottledSchedulerOptions;
  summary?: readonly SummaryRenderer[];
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
 * Declare a workflow: its scheduler options, its step summary's renderers (default
 * DEFAULT_SUMMARY_RENDERERS), and its implementation, which builds the graph through a bound
 * `Workflow` facade. The scheduler options' group names flow into the facade's types, so
 * `group: "tset"` does not compile. defineWorkflow wraps the implementation you write into the
 * `Implementation` the definition holds: one that takes the graph, ports and context, binds the
 * facade to them, and resolves to what your implementation returns.
 */
export function defineWorkflow<S extends ThrottledSchedulerOptions, R = void>(def: {
  schedulerOptions?: S;
  summary?: readonly SummaryRenderer[];
  implementation: (workflow: Workflow<GroupsOf<S>>) => R | Promise<R>;
}): WorkflowDef<R> {
  return {
    [WORKFLOW_DEF]: true,
    ...(def.schedulerOptions && { schedulerOptions: def.schedulerOptions }),
    ...(def.summary && { summary: def.summary }),
    implementation: async (graph, ports, ctx) =>
      def.implementation(createWorkflow<GroupsOf<S>>(graph, ports, ctx)),
  };
}
