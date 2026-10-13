import {
  optional,
  type Graph,
  type NodeRef,
  type OptionalRef,
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
  type PostSpec,
  type RestoreCacheSpec,
  type RunRef,
  type RunSpec,
} from "./steps.ts";

/** The concurrency groups a limits object declares, or `never` when it declares none. */
export type GroupsOf<L> = L extends { concurrencyLimits: infer C }
  ? Extract<keyof C, string>
  : never;

/**
 * The step vocabulary bound to one graph, ports and CI context, so a workflow body never
 * threads them through and needs no runtime import but `defineWorkflow`. `G` is the set of
 * concurrency groups the workflow's limits declare.
 */
export interface Steps<G extends string = string> {
  graph: Graph;
  ports: Ports;
  ctx: CiContext;
  glob: (...patterns: string[]) => Promise<string[]>;
  /** One hash over the files' contents, for a cache key. */
  hash: (...files: string[]) => Promise<string>;
  run: <O extends string = never>(spec: RunSpec<G, O> & { name: string }) => RunRef<O>;
  runAll: <K extends string>(specs: Record<K, RunSpec<G>>) => Record<K, RunRef>;
  gate: (opts: { name?: string; deps: Record<string, NodeRef> }) => NodeRef<string>;
  /** A command as the `post:` of `main`: never cached, runs after its `deps`, and after a cancel. */
  post: <O extends string = never>(spec: PostSpec<G, O> & { name: string }) => RunRef<O>;
  /** `actions/cache/restore` as a node. */
  restoreCache: (spec: RestoreCacheSpec) => NodeRef<string>;
  /** `actions/cache/save` as its post step; `cache` is the restore node it saves for. */
  saveCache: (opts: {
    name: string;
    cache: NodeRef<string>;
    deps: Record<string, NodeRef | OptionalRef | undefined>;
  }) => NodeRef<string>;
  /** Mark a dep the consumer runs without when it failed: GitHub's `if: always()`. */
  optional: typeof optional;
}

export function createSteps<G extends string>(
  graph: Graph,
  ports: Ports,
  ctx: CiContext,
): Steps<G> {
  return {
    graph,
    ports,
    ctx,
    glob: (...patterns) => glob(patterns),
    hash: (...files) => hashFiles(ports, files),
    run: (spec) => run(graph, ports, spec),
    runAll: (specs) => runAll(graph, ports, specs),
    gate: (opts) => gate(graph, ports, opts),
    post: (spec) => post(graph, ports, spec),
    restoreCache: (spec) => restoreCache(graph, ports, spec),
    saveCache: (opts) => saveCache(graph, ports, opts),
    optional,
  };
}

/** What a workflow file default-exports. `R` is what its body returns: refs another workflow composes. */
export interface WorkflowDef<R = unknown> {
  workflow: Workflow<R>;
  limits?: ThrottledSchedulerOptions;
}

/**
 * Declare a workflow: its scheduler limits and a body that builds the graph through a bound
 * `Steps` facade. The limits' group names flow into the facade's types, so `group: "tset"`
 * does not compile. The body's return value is the workflow's: a release workflow calls
 * `ci.workflow(w.graph, w.ports, w.ctx)` and depends on the gate it gets back.
 */
export function defineWorkflow<L extends ThrottledSchedulerOptions, R = void>(def: {
  limits?: L;
  build: (w: Steps<GroupsOf<L>>) => R | Promise<R>;
}): WorkflowDef<R> {
  return {
    ...(def.limits && { limits: def.limits }),
    workflow: async (graph, ports, ctx) => def.build(createSteps<GroupsOf<L>>(graph, ports, ctx)),
  };
}
