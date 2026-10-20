/* eslint-disable @typescript-eslint/no-explicit-any */
import { addNode, type Graph } from "./graph/graph.ts";
import { checkInputs } from "./graph/inputs.ts";
import type {
  ActionContext,
  BaseParams,
  InvalidateOn,
  NodeParams,
  NodeRef,
  Outputs,
} from "./graph/types.ts";

/** The longest delay setTimeout honors; a longer one fires at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** What `defineAction` takes. Only `inputs` and the deps' content join a node's key. */
export interface ActionSpec<Ports, P extends BaseParams, R extends Outputs, I> {
  /** What kind of work it is, as Bazel's mnemonic: a label for display and routing, not keyed. */
  kind: string;
  /** Inputs every node of the action has, such as a version that names the action's logic. */
  inputs?: I;
  action: (context: ActionContext<Ports, P, I>) => Promise<R>;
  invalidateOn?: InvalidateOn<Ports, P>;
  /** `false` runs the node in every execution: its entry is never read or written. */
  cacheable?: boolean;
  concurrencyGroup?: string;
  /** How long the action may run, in ms, counted from its start. Not keyed. */
  timeoutMs?: number;
}

/** A kind of work, defined once. `addNode` adds one of its nodes to a graph. */
export interface Action<Ports, P extends BaseParams, R extends Outputs> {
  addNode<GraphPorts extends Ports, Meta>(
    graph: Graph<GraphPorts, Meta>,
    params: NodeParams<P, Meta>,
  ): NodeRef<R>;
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

const GONE: Record<string, string> = {
  config:
    "config is gone: declare it in inputs (config: { version: 1 } becomes inputs: { version: 1 })",
  normalize: "normalize is gone: declare invalidateOn: { [role]: (outputs, ports) => fingerprint }",
};

export function defineAction<
  Ports,
  P extends BaseParams,
  R extends Outputs,
  I = Record<string, unknown>,
>(spec: ActionSpec<Ports, P, R, I>): Action<Ports, P, R> {
  if (typeof spec.kind !== "string" || spec.kind === "")
    throw new Error("defineAction: kind is required, the kind of work the action does");
  const where = `action "${spec.kind}"`;
  for (const field of Object.keys(spec))
    if (GONE[field]) throw new Error(`${where}: ${GONE[field]}`);
  const t = spec.timeoutMs;
  if (t !== undefined && !(Number.isInteger(t) && t > 0 && t <= MAX_TIMEOUT_MS))
    throw new RangeError(
      `${where}: timeoutMs must be a whole number of ms from 1 to ${MAX_TIMEOUT_MS}, got ${t}`,
    );
  const checked = { ...spec, inputs: checkInputs(spec.inputs, where) };
  return { addNode: (graph, params) => addNode<R>(graph, checked, params as object) };
}
