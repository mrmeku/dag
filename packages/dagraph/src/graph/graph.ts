/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ActionSpec } from "../define-action.ts";
import { checkInputs, outputRefsIn } from "./inputs.ts";
import { nodeRef, type Node, type NodeRef, type Outputs } from "./types.ts";

/** A node as the graph holds it: its data, its action, its deps by role and its inputs. */
export interface GraphNode {
  node: Node<unknown>;
  spec: ActionSpec<any, any, any, any>;
  /** Each role's dep, by node name. */
  roles: Record<string, string>;
  /** The action's inputs and the node's own, checked. */
  inputs: Record<string, unknown>;
}

interface GraphState {
  nodes: Map<string, GraphNode>;
  prefix: string;
  meta: unknown;
}

const states = new WeakMap<object, GraphState>();
const stateOf = (graph: object) => states.get(graph)!;

/**
 * Nodes and their deps, typed by the ports their actions need and the metadata its nodes carry.
 * `addNode` adds a node; `describe()` is the one view of a graph.
 */
export class Graph<Ports = unknown, Meta = undefined> {
  declare readonly _ports?: Ports;

  constructor() {
    states.set(this, { nodes: new Map(), prefix: "", meta: undefined });
  }

  /**
   * A view of this graph that prefixes `prefix:` to the name of each node added through it and
   * gives each its `meta`, unless the node gives its own. Without `meta`, its parent's applies.
   */
  subgraph(prefix: string, meta?: Meta): Graph<Ports, Meta> {
    const parent = stateOf(this);
    const view = new Graph<Ports, Meta>();
    states.set(view, {
      nodes: parent.nodes,
      prefix: parent.prefix ? `${parent.prefix}:${prefix}` : prefix,
      meta: meta === undefined ? parent.meta : meta,
    });
    return view;
  }

  /** Each node as data, in the order they were added. */
  describe(): Node<Meta>[] {
    return [...stateOf(this).nodes.values()].map(
      ({ node }) =>
        ({
          ...node,
          deps: [...node.deps],
          ...(node.settledDeps && { settledDeps: [...node.settledDeps] }),
        }) as Node<Meta>,
    );
  }
}

export const graphNodes = (graph: Graph<any, any>): ReadonlyMap<string, GraphNode> =>
  stateOf(graph).nodes;

const PARAMS = new Set(["name", "deps", "inputs", "meta"]);

export function addNode<R extends Outputs>(
  graph: Graph<any, any>,
  spec: ActionSpec<any, any, any, any>,
  params: {
    name?: string;
    meta?: unknown;
    deps?: Record<string, { name: string; settled?: boolean } | undefined>;
    inputs?: unknown;
  },
): NodeRef<R> {
  const state = stateOf(graph);
  const own = params.name ?? spec.kind;
  const name = state.prefix ? `${state.prefix}:${own}` : own;
  const where = `node "${name}"`;
  const extra = Object.keys(params).filter((k) => !PARAMS.has(k));
  if (extra.length > 0)
    throw new Error(
      `${where}: params hold only name, deps, inputs and meta, not ${extra.join(", ")}. ` +
        (extra.includes("kind")
          ? "A kind is its action's: defineAction({ kind })."
          : "What decides the output reaches the action as an input: inputs: { ... }."),
    );
  if (state.nodes.has(name))
    throw new Error(
      `Duplicate node name "${name}". Names are unique in a graph: give the node a name of its ` +
        `own, or add it through graph.subgraph(prefix, meta).`,
    );

  const roles = Object.entries(params.deps ?? {}).flatMap(([role, ref]) =>
    ref ? [[role, ref] as const] : [],
  );
  for (const [role, ref] of roles)
    if (!state.nodes.has(ref.name))
      throw new Error(`${where} depends on unknown node "${ref.name}" (deps.${role})`);
  // Two roles may name one node: it is one dep, and required if either role requires it.
  const deps = [...new Set(roles.map(([, ref]) => ref.name))];
  const required = new Set(roles.filter(([, ref]) => !ref.settled).map(([, ref]) => ref.name));
  const settledDeps = deps.filter((dep) => !required.has(dep));

  const ownInputs = checkInputs(params.inputs, where);
  const redeclared = Object.keys(ownInputs).filter((k) => Object.hasOwn(spec.inputs, k));
  if (redeclared.length > 0)
    throw new Error(`${where}: inputs.${redeclared[0]} is declared by its action "${spec.kind}"`);
  const inputs = { ...spec.inputs, ...ownInputs };
  for (const [input, value] of Object.entries(inputs))
    for (const ref of outputRefsIn(value))
      if (!deps.includes(ref.node))
        throw new Error(
          `${where}: inputs.${input} names "${ref.node}".outputs.${ref.output}, but "${ref.node}" ` +
            `is not in its deps. Naming an output does not make a dep: declare it in deps.`,
        );

  const meta = params.meta === undefined ? state.meta : params.meta;
  const node: Node<unknown> = {
    name,
    kind: spec.kind,
    ...(meta !== undefined && { meta }),
    deps,
    ...(settledDeps.length > 0 && { settledDeps }),
    ...(spec.concurrencyGroup !== undefined && { concurrencyGroup: spec.concurrencyGroup }),
    ...(spec.cacheable === false && { cacheable: false }),
    ...(spec.timeoutMs !== undefined && { timeoutMs: spec.timeoutMs }),
  };
  state.nodes.set(name, {
    node,
    spec,
    roles: Object.fromEntries(roles.map(([role, ref]) => [role, ref.name])),
    inputs,
  });
  return nodeRef<R>(name);
}

/**
 * The graph of the named nodes and every node they depend on, `settled` deps included, each as
 * it is, in the order they were added. Executing it runs part of a graph against the same entries.
 */
export function closure<Ports, Meta>(
  graph: Graph<Ports, Meta>,
  names: Iterable<string>,
): Graph<Ports, Meta> {
  const { nodes } = stateOf(graph);
  const kept = new Set<string>();
  const visit = (name: string) => {
    if (kept.has(name)) return;
    const found = nodes.get(name);
    if (!found) throw new Error(`closure: the graph holds no node "${name}"`);
    kept.add(name);
    found.node.deps.forEach(visit);
  };
  for (const name of names) visit(name);
  const result = new Graph<Ports, Meta>();
  const target = stateOf(result).nodes;
  for (const [name, n] of nodes) if (kept.has(name)) target.set(name, n);
  return result;
}
