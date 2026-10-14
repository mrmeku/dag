/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  addNode,
  type ActionFunc,
  type BaseParams,
  type Graph,
  type NodeRef,
  type Normalizers,
  type Outputs,
} from "./graph/index.ts";

/**
 * Bound action ready to wire into a graph. Call addNode() to register it in a Graph, or
 * createAction() to get the raw function (useful for testing or Temporal activity registration).
 */
export interface Action<Ctx, P extends BaseParams, R extends Outputs> {
  addNode: (graph: Graph, ctx: Ctx, params: P) => NodeRef<R>;
  createAction: (ctx: Ctx) => ActionFunc<P, R>;
}

/** Extract output type R from an Action or a factory function that returns one. */
export type OutputOf<T> =
  T extends Action<any, any, infer R>
    ? R
    : T extends (...args: any[]) => Action<any, any, infer R>
      ? R
      : never;

/** Extract NodeRef<R> from an Action or a factory function that returns one. */
export type NodeRefOf<T> = NodeRef<OutputOf<T>>;

/**
 * JSON.stringify with sorted object keys — ensures identical config objects always produce the
 * same string regardless of property insertion order.
 */
function deterministicStringify(obj: unknown) {
  return JSON.stringify(obj, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/**
 * Create a reusable action from a spec. Serializes config deterministically so that
 * config changes invalidate the cache. The returned Action can add nodes to any number of graphs.
 */
export function defineAction<Ctx, P extends BaseParams, R extends Outputs, C = string>(spec: {
  config: C;
  concurrencyGroup?: string;
  /** `false` runs the node every time; see `Node.cacheable`. */
  cacheable?: boolean;
  /** How long the action may run before its signal aborts; see `Node.timeoutMs`. Not in the key. */
  timeoutMs?: number;
  action: (ctx: Ctx, config: C) => ActionFunc<P, R>;
  /** Fingerprints for deps this action reads only part of; see `Node.normalize`. */
  normalize?: (ctx: Ctx) => Normalizers<P>;
}): Action<Ctx, P, R> {
  const configStr =
    typeof spec.config === "string" ? spec.config : deterministicStringify(spec.config);
  return {
    addNode: (graph, ctx, params) =>
      addNode({
        graph,
        name: params.kind,
        config: configStr,
        ...(spec.concurrencyGroup && { concurrencyGroup: spec.concurrencyGroup }),
        ...(spec.cacheable === false && { cacheable: false }),
        ...(spec.timeoutMs !== undefined && { timeoutMs: spec.timeoutMs }),
        params,
        action: spec.action(ctx, spec.config),
        ...(spec.normalize && { normalize: spec.normalize(ctx) }),
      }),
    createAction: (ctx) => spec.action(ctx, spec.config),
  };
}
