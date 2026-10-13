/** Minimum contract for parameters passed to `addNode`. `kind` groups nodes for display/counting. */
export interface BaseParams {
  kind: string;
  deps?: Record<string, NodeRef | OptionalRef | undefined>;
  /** Files outside the graph this node reads. Their content hashes join the action key. */
  inputs?: string[];
}

/** Constrained output type: actions must return file paths. */
export type Outputs = string | string[] | Record<string, string | string[]>;

/**
 * Maps a params object's `deps` record to the deserialized output types of each dependency.
 * Unwired (`?`) and optional deps resolve to `T | undefined`.
 */
export type InputsFor<P> = P extends { deps: infer D }
  ? {
      [K in keyof D]: D[K] extends NodeRef<infer T>
        ? T
        : D[K] extends NodeRef<infer T> | OptionalRef<infer T> | undefined
          ? T | undefined
          : unknown;
    }
  : Record<string, never>;

/** What the executor tells a running action: the signal fires when the execution is cancelled. */
export interface ActionContext {
  signal?: AbortSignal;
}

/**
 * User-supplied function that implements a DAG node's work. Receives typed params, dep outputs,
 * the CAS output dir, and the execution's context; an action that can stop early watches
 * `ctx.signal`, the rest ignore the argument.
 */
export type ActionFunc<P extends BaseParams, R extends Outputs> = (
  params: P,
  inputs: InputsFor<P>,
  outputDir: string,
  ctx?: ActionContext,
) => Promise<R>;

/** Serializable identity of a DAG node — no closures, safe for cross-process communication. */
export interface Node {
  name: string;
  kind: string;
  /** Names of nodes this node depends on (must complete first). */
  deps: string[];
  /** Serialized configuration — included in the action key so config changes invalidate cache. */
  config: string;
  /** Subset of `deps` that may fail: the node runs without their outputs instead of failing too. */
  optionalDeps?: string[];
  /**
   * Paths of files outside the graph this node reads (sources, lockfiles). Hashed into the action
   * key like dep outputs, so a change to any of them re-runs the node. Paths are hashed as given.
   */
  inputs?: string[];
  /** Optional concurrency group. Nodes sharing a group are subject to a per-group parallelism limit. */
  concurrencyGroup?: string;
  /**
   * `false` makes the node run on every execution: the cache is neither read nor written for it.
   * Its outputs are still hashed, so downstream nodes keep caching by content. For nondeterministic
   * work such as integration tests.
   */
  cacheable?: boolean;
}

/** A Node with an executable action — the unit of work the executor actually runs. */
export interface RunnableNode extends Node {
  params: BaseParams;
  /** Raw executor-level action. Receives dep outputs as `Record<name, Outputs>` and CAS output dir, returns Outputs. */
  action: (
    rawInputs: Record<string, Outputs>,
    outputDir: string,
    ctx?: ActionContext,
  ) => Promise<Outputs>;
  /**
   * Fingerprints of dependencies, keyed by dep node name, that stand in for the dep's content
   * hash in this node's action key. Each declares the part of a dep's output this node reads:
   * while that part is unchanged, the node stays cached whatever else the dep's output changed.
   */
  normalize?: Record<string, (outputs: Outputs) => Promise<string>>;
}

/**
 * Per-dependency fingerprint functions for a node's deps, keyed by dep role. Return a string that
 * captures exactly what the node reads from that dep; it is hashed into the action key in place
 * of the dep's content hash.
 */
export type Normalizers<P extends BaseParams> = {
  [K in keyof InputsFor<P>]?: (outputs: NonNullable<InputsFor<P>[K]>) => Promise<string> | string;
};

/** Output of `graph.analyze()` — structural info, no cache prediction. */
export interface AnalysisResult {
  nodes: Node[];
  total: number;
  byKind: Map<string, number>;
}

/** Type-safe handle to a DAG node. T is the output type of the node's action. */
export interface NodeRef<T extends Outputs = Outputs> {
  name: string;
  readonly _T?: T;
  readonly optional?: false;
}

/**
 * Handle to a dependency the consumer can run without. If it fails, the consumer still runs
 * (its input is undefined) and re-runs on a later execution once the dependency succeeds.
 */
export interface OptionalRef<T extends Outputs = Outputs> {
  name: string;
  readonly _T?: T;
  readonly optional: true;
}

export function optional<T extends Outputs>(ref: NodeRef<T>): OptionalRef<T> {
  return { name: ref.name, optional: true };
}

export function requiredDeps(node: Node): string[] {
  return node.deps.filter((d) => !node.optionalDeps?.includes(d));
}
