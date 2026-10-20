import {
  settled,
  type Graph,
  type NodeRef,
  type SettledRef,
  type ThrottledSchedulerOptions,
} from "@mrmeku/dagraph";
import type { CiContext, Ports } from "./ports.ts";
import type { Workflow } from "./runner.ts";
import {
  gate,
  glob,
  hashFiles,
  post,
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

/** The concurrency groups a limits object declares, or `never` when it declares none. */
export type GroupsOf<L> = L extends { concurrencyLimits: infer C }
  ? Extract<keyof C, string>
  : never;

/**
 * The step vocabulary bound to one graph, ports and CI context, so a workflow body never
 * threads them through and needs no runtime import but `defineWorkflow`. `G` is the set of
 * concurrency groups the workflow's limits declare. A builder that uses no group takes `Steps`,
 * the facade of every workflow; one that uses `group: "mix"` takes `Steps<"mix">`, and only a
 * workflow that declares `mix` can call it.
 */
export interface Steps<G extends string = never> {
  graph: Graph<Ports>;
  ports: Ports;
  ctx: CiContext;
  glob: (...patterns: string[]) => Promise<string[]>;
  /** The `hashFiles()` of a workflow file: one hash over the matched files' contents, for a cache key. */
  hash: (...patterns: string[]) => Promise<string>;
  run: <O extends string = never>(spec: RunSpec<G, O> & { name: string }) => RunRef<O>;
  runAll: <K extends string>(specs: Record<K, RunSpec<G>>) => Record<K, RunRef>;
  gate: (opts: { name?: string; deps: Record<string, NodeRef> }) => NodeRef<string>;
  /** A command as the `post:` of `main`: never cached, runs after its `deps`, and after a cancel. */
  post: <O extends string = never>(spec: PostSpec<G, O> & { name: string }) => RunRef<O>;
  /** `actions/cache/restore` as a node. */
  restoreCache: (spec: RestoreCacheSpec) => RestoreCacheRef;
  /** `actions/cache/save` as its post step; `cache` is the restore node it saves for. */
  saveCache: (opts: {
    name: string;
    cache: RestoreCacheRef;
    deps: Record<string, NodeRef | SettledRef | undefined>;
  }) => NodeRef<string>;
  /** `actions/upload-artifact` as a node: globs and dep outputs up as one artifact of the run. */
  uploadArtifact: (spec: UploadArtifactSpec) => NodeRef<string>;
  /** Mark a dep the consumer runs without when it failed: GitHub's `if: always()`. */
  settled: typeof settled;
}

export function createSteps<G extends string>(
  graph: Graph<Ports>,
  ports: Ports,
  ctx: CiContext,
): Steps<G> {
  return {
    graph,
    ports,
    ctx,
    glob: (...patterns) => glob(patterns),
    hash: (...patterns) => hashFiles(patterns),
    run: (spec) => run(graph, spec),
    runAll: (specs) => runAll(graph, specs),
    gate: (opts) => gate(graph, opts),
    post: (spec) => post(graph, spec),
    restoreCache: (spec) => restoreCache(graph, spec),
    saveCache: (opts) => saveCache(graph, opts),
    uploadArtifact: (spec) => uploadArtifact(graph, spec),
    settled,
  };
}

/** What a workflow file default-exports. `R` is what its body returns: refs another workflow composes. */
export interface WorkflowDef<R = unknown> {
  workflow: Workflow<R>;
  limits?: ThrottledSchedulerOptions;
  summary?: readonly SummaryRenderer[];
}

/**
 * Declare a workflow: its scheduler limits, its step summary's renderers (default
 * DEFAULT_SUMMARY_RENDERERS), and a body that builds the graph through a bound `Steps` facade.
 * The limits' group names flow into the facade's types, so `group: "tset"` does not compile.
 * The body's return value is the workflow's: a release workflow calls
 * `ci.workflow(w.graph, w.ports, w.ctx)` and depends on the gate it gets back.
 */
export function defineWorkflow<L extends ThrottledSchedulerOptions, R = void>(def: {
  limits?: L;
  summary?: readonly SummaryRenderer[];
  build: (w: Steps<GroupsOf<L>>) => R | Promise<R>;
}): WorkflowDef<R> {
  return {
    ...(def.limits && { limits: def.limits }),
    ...(def.summary && { summary: def.summary }),
    workflow: async (graph, ports, ctx) => def.build(createSteps<GroupsOf<L>>(graph, ports, ctx)),
  };
}
