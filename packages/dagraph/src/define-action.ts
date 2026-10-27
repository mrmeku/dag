import { addNode, type Graph } from "./graph/graph.ts";
import { checkInputs } from "./graph/inputs.ts";
import {
  DEP,
  depRefs,
  pickedOutputs,
  requiredRoles,
  type ActionContext,
  type DepSpecs,
  type InputRecord,
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
 * `nodeInputs` and `inputs`, and the outputs, `R`, by what `action` returns. Only the kind, the
 * inputs and the deps' content join a node's key; `deps` and `nodeInputs` declare, and each node
 * gives.
 */
export interface ActionSpec<
  Ports,
  R,
  D,
  N extends InputRecord<unknown>,
  I,
  Group extends string = never,
> {
  /**
   * What kind of work it is, as Bazel's mnemonic. It names the action's logic and joins the key,
   * so actions of two kinds never share an entry. Nodes of one kind that differ put what differs
   * in their node inputs.
   */
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
   * `nodeInputs<{ url: string }>`. `N` is that record type. Each node gives only these names.
   */
  nodeInputs?: NodeInputsSpec<N> | (() => NodeInputsSpec<N>);
  /** Inputs every node of the action has, such as a version that names the action's logic. */
  inputs?: I;
  // NoInfer: the deps and inputs come from their fields, never from a function typed elsewhere.
  // `R & Outputs`, not a constraint on R: a constraint would keep a returned template literal's
  // type, as `${string}/out.txt`, where the outputs are a path.
  action: (context: NoInfer<ActionContext<Ports, D, I & N>>) => Promise<R & Outputs>;
  /** `false` runs the node in every execution: its entry is never read or written. */
  cacheable?: boolean;
  /** The group whose limit it runs under, with `throttledScheduler`: one that `actionsFor` names. */
  concurrencyGroup?: Group;
  /** How long the action may run, in ms, counted from its start. Not keyed. */
  timeoutMs?: number;
}

/**
 * An action as a graph holds it, its types erased: the engine builds each context from its
 * node's inputs and its deps' entries, so the action takes the context of no action in particular.
 */
export interface ErasedSpec extends Pick<
  ActionSpec<unknown, unknown, DepSpecs, InputRecord<unknown>, InputRecord, string>,
  "kind" | "cacheable" | "concurrencyGroup" | "timeoutMs"
> {
  inputs: Record<string, unknown>;
  requiredRoles: string[];
  pickedOutputs: Record<string, readonly string[]>;
  action: (
    context: Omit<ActionContext, "inputs" | "depOutputs"> & {
      inputs: Record<string, unknown>;
      depOutputs: Record<string, unknown>;
    },
  ) => Promise<Outputs>;
}

/**
 * A kind of work, defined once. `addNode` adds one of its nodes to a graph and returns a ref to
 * it, a `NodeRef<R>`. `R` is its outputs, `D` its deps, `N` its node inputs and `I` its own inputs,
 * each as its spec declares them; `ND` and `NI`, inferred from the node, are the deps and the
 * inputs it gives.
 */
export interface Action<Ports, R extends Outputs, D = Empty, N = Empty, I = Empty> {
  /** An action is a dep: `deps: { fetch }` declares a role that a node of `fetch` fills. */
  readonly [DEP]: true;
  readonly _T?: R;
  /** It takes its ports, so an action is never typed as one that needs fewer. */
  readonly _ports?: (ports: Ports) => void;
  // A property, not a method, so its params are compared strictly and an action is never typed
  // as one that takes other deps or inputs.
  readonly addNode: <GraphPorts extends Ports, Meta, ND extends NodeDeps<D> = NodeDeps<D>, NI = N>(
    graph: Graph<GraphPorts, Meta>,
    params: NodeParams<D, N, I, Meta, ND, NI>,
  ) => NodeRef<R>;
}

/** The outputs of an action, a ref or a dep: `OutputOf<typeof fetch>`. */
export type OutputOf<T> = T extends { readonly _T?: infer R extends Outputs } ? R : never;

/** A ref to a node of an action: `NodeRefOf<typeof fetch>`. */
export type NodeRefOf<T> = NodeRef<OutputOf<T>>;

function define<
  Ports,
  R,
  D extends DepSpecs,
  N extends InputRecord<unknown>,
  I extends InputRecord,
>(spec: ActionSpec<Ports, R, D, N, I, string>): Action<Ports, Extract<R, Outputs>, D, N, I> {
  const where = `action "${spec.kind}"`;
  const t = spec.timeoutMs;
  if (t !== undefined && !(Number.isInteger(t) && t > 0 && t <= MAX_TIMEOUT_MS))
    throw new RangeError(
      `${where}: timeoutMs must be a whole number of ms from 1 to ${MAX_TIMEOUT_MS}, got ${t}`,
    );
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- a graph holds actions of many types as data, which erases each context's inputs, dep outputs and ports
  const checked = {
    ...spec,
    inputs: checkInputs(spec.inputs, where),
    requiredRoles: requiredRoles(spec.deps ?? {}),
    pickedOutputs: pickedOutputs(spec.deps ?? {}),
  } as unknown as ErasedSpec;
  return {
    [DEP]: true,
    addNode: <GraphPorts extends Ports, Meta, ND extends NodeDeps<D>, NI>(
      graph: Graph<GraphPorts, Meta>,
      params: NodeParams<D, N, I, Meta, ND, NI>,
    ) =>
      addNode<Extract<R, Outputs>, GraphPorts, Meta>(graph, checked, params, () =>
        typeof params.inputs === "function" ? params.inputs(depRefs(params.deps)) : params.inputs,
      ),
  };
}

/**
 * `defineAction` bound to a program's ports, the one type it cannot infer: bind it once,
 * `const defineActionWithPorts = actionsFor<Ports>()`, and every other type comes from each spec.
 * An action may join only a group the program names, `actionsFor<Ports, keyof typeof limits>()`
 * over its `throttledScheduler`'s `concurrencyLimits`, so a misspelt group does not compile.
 * An action's outputs are what it returns, a path as `string`, a list as `string[]`.
 */
export function actionsFor<Ports, Group extends string = never>() {
  return <
    R,
    D extends DepSpecs = Empty,
    N extends InputRecord<unknown> = Empty,
    I extends InputRecord = Empty,
  >(
    spec: ActionSpec<Ports, R, D, N, I, Group>,
  ): Action<Ports, Extract<R, Outputs>, D, N, I> => define(spec);
}

/** An action that needs no ports. A program with ports binds its own: `actionsFor<Ports>()`. */
export const defineAction = actionsFor<unknown>();
