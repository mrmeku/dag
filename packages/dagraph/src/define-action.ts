import { addNode, type Graph } from "./graph/graph.ts";
import { checkInputs } from "./graph/inputs.ts";
import {
  DEP,
  depRefs,
  type ActionContext,
  type DepSpecs,
  type InputRecord,
  type InvalidateOn,
  type NodeDeps,
  type NodeInputsSpec,
  type NodeParams,
  type NodeRef,
  type Outputs,
} from "./graph/types.ts";

/** The longest delay setTimeout honors; a longer one fires at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;

type Empty = Record<never, never>;

/**
 * What `defineAction` takes. Its types come from its fields: the deps by `deps`, the inputs by
 * `nodeInputs` and `inputs`, and the outputs, `R`, by what `action` returns. Only the inputs and
 * the deps' content join a node's key; `deps` and `nodeInputs` declare, and each node gives.
 */
export interface ActionSpec<Ports, R, D, N extends InputRecord<unknown>, I> {
  /** What kind of work it is, as Bazel's mnemonic: a label for display and routing, not keyed. */
  kind: string;
  /**
   * The deps each node gives, by role. A role is the action that produces it, `{ fetch }`, or
   * `dep<T>` when more than one can; `settled` marks one its node runs without, and `maybe` one a
   * node may leave out, each called around an action, `settled(fetch)`, and uncalled around a
   * type, `settled<T>`. A record typed `DepSpecs` takes any role.
   */
  deps?: D;
  /**
   * The inputs each node gives when it is added, by name and type, uncalled:
   * `nodeInputs<{ url: string }>`. `N` is that record type.
   */
  nodeInputs?: NodeInputsSpec<N> | (() => NodeInputsSpec<N>);
  /** Inputs every node of the action has, such as a version that names the action's logic. */
  inputs?: I;
  // NoInfer: the deps and inputs come from their fields, never from a function typed elsewhere.
  // `R & Outputs`, not a constraint on R: a constraint would keep a returned template literal's
  // type, as `${string}/out.txt`, where the outputs are a path.
  action: (context: NoInfer<ActionContext<Ports, D, I & N>>) => Promise<R & Outputs>;
  invalidateOn?: NoInfer<InvalidateOn<Ports, D>>;
  /** `false` runs the node in every execution: its entry is never read or written. */
  cacheable?: boolean;
  concurrencyGroup?: string;
  /** How long the action may run, in ms, counted from its start. Not keyed. */
  timeoutMs?: number;
}

/**
 * An action as a graph holds it, its types erased: the engine builds each context from its
 * node's inputs and its deps' entries, so the action takes the context of no action in particular,
 * and its fingerprints the handles of no output in particular.
 */
export interface ErasedSpec {
  kind: string;
  inputs: Record<string, unknown>;
  action: (
    context: Omit<ActionContext, "inputs" | "depOutputs"> & {
      inputs: Record<string, unknown>;
      depOutputs: Record<string, unknown>;
    },
  ) => Promise<Outputs>;
  invalidateOn?: Record<string, (outputs: unknown, ports: unknown) => Promise<string> | string>;
  cacheable?: boolean;
  concurrencyGroup?: string;
  timeoutMs?: number;
}

/**
 * A kind of work, defined once. `addNode` adds one of its nodes to a graph and returns a ref to
 * it, a `NodeRef<R>`. `R` is its outputs, `D` its deps, `N` its node inputs and `I` its own inputs,
 * each as its spec declares them; `ND`, inferred from the node, is its deps where `D` takes any role.
 */
export interface Action<Ports, R extends Outputs, D = Empty, N = Empty, I = Empty> {
  /** An action is a dep: `deps: { fetch }` declares a role that a node of `fetch` fills. */
  readonly [DEP]: true;
  readonly _T?: R;
  addNode<GraphPorts extends Ports, Meta, ND extends NodeDeps<D> = NodeDeps<D>>(
    graph: Graph<GraphPorts, Meta>,
    params: NodeParams<D, N, I, Meta, ND>,
  ): NodeRef<R>;
}

/** The outputs of an action, a ref or a dep: `OutputOf<typeof fetch>`. */
export type OutputOf<T> = T extends { readonly _T?: infer R extends Outputs } ? R : never;

/** A ref to a node of an action: `NodeRefOf<typeof fetch>`. */
export type NodeRefOf<T> = NodeRef<OutputOf<T>>;

function define<Ports, R, D, N extends InputRecord<unknown>, I extends InputRecord>(
  spec: ActionSpec<Ports, R, D, N, I>,
): Action<Ports, Extract<R, Outputs>, D, N, I> {
  const where = `action "${spec.kind}"`;
  const t = spec.timeoutMs;
  if (t !== undefined && !(Number.isInteger(t) && t > 0 && t <= MAX_TIMEOUT_MS))
    throw new RangeError(
      `${where}: timeoutMs must be a whole number of ms from 1 to ${MAX_TIMEOUT_MS}, got ${t}`,
    );
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a graph holds actions of many types as data, which erases each context's inputs, dep outputs and ports
  const checked = { ...spec, inputs: checkInputs(spec.inputs, where) } as unknown as ErasedSpec;
  return {
    [DEP]: true,
    addNode: <Meta, ND extends NodeDeps<D>>(
      graph: Graph<Ports, Meta>,
      params: NodeParams<D, N, I, Meta, ND>,
    ) =>
      addNode<Extract<R, Outputs>, Meta>(graph, checked, params, () =>
        typeof params.inputs === "function" ? params.inputs(depRefs(params.deps)) : params.inputs,
      ),
  };
}

/**
 * `defineAction` bound to a program's ports, the one type it cannot infer: bind it once,
 * `const defineActionWithPorts = actionsFor<Ports>()`, and every other type comes from each spec.
 * An action's outputs are what it returns, a path as `string`, a list as `string[]`.
 */
export function actionsFor<Ports>() {
  return <
    R,
    D extends DepSpecs = Empty,
    N extends InputRecord<unknown> = Empty,
    I extends InputRecord = Empty,
  >(
    spec: ActionSpec<Ports, R, D, N, I>,
  ): Action<Ports, Extract<R, Outputs>, D, N, I> => define(spec);
}

/** An action that needs no ports. A program with ports binds its own: `actionsFor<Ports>()`. */
export const defineAction = actionsFor<unknown>();
