import type { ErasedSpec } from "../define-action.ts";
import { checkInputs } from "./inputs.ts";
import {
  nodeRef,
  type DepRecord,
  type InputRecord,
  type Node,
  type NodeRef,
  type Outputs,
} from "./types.ts";

/** A node as the graph holds it: its data, its action, its deps by role and its inputs. */
export interface GraphNode<Meta = unknown> {
  node: Node<Meta>;
  spec: ErasedSpec;
  /** Each role's dep, by node name. */
  roles: Record<string, string>;
  /** The action's inputs and the node's own, checked. */
  inputs: Record<string, unknown>;
}

interface GraphState<Meta> {
  nodes: Map<string, GraphNode<Meta>>;
  prefix: string;
  meta: Meta | undefined;
}

let stateOf: <Ports, Meta>(graph: Graph<Ports, Meta>) => GraphState<Meta>;

/**
 * Nodes and their deps, typed by the ports their actions need and the metadata its nodes carry.
 * `addNode` adds a node; `describe()` is the one view of a graph.
 */
export class Graph<Ports = unknown, Meta = undefined> {
  // Each marker takes and returns its type, so a graph is never typed by other ports or meta.
  declare readonly _ports?: (ports: Ports) => Ports;
  declare readonly _meta?: (meta: Meta) => Meta;
  #state: GraphState<Meta> = { nodes: new Map(), prefix: "", meta: undefined };

  static {
    stateOf = (graph) => graph.#state;
  }

  /**
   * A view of this graph that prefixes `prefix:` to the name of each node added through it and
   * gives each its `meta`, unless the node gives its own. Without `meta`, its parent's applies.
   * It holds the nodes under its prefix and every node they depend on.
   */
  subgraph(prefix: string, meta?: Meta): Graph<Ports, Meta> {
    const parent = this.#state;
    const view = new Graph<Ports, Meta>();
    view.#state = {
      nodes: parent.nodes,
      prefix: parent.prefix ? `${parent.prefix}:${prefix}` : prefix,
      meta: meta === undefined ? parent.meta : meta,
    };
    return view;
  }

  /** Each node as data, in the order they were added. */
  describe(): Node<Meta>[] {
    return [...graphNodes(this).values()].map(({ node }) => ({
      ...node,
      deps: [...node.deps],
      ...(node.settledDeps && { settledDeps: [...node.settledDeps] }),
    }));
  }
}

/** The named nodes and every node they depend on, in the order they were added. */
function withDeps<Meta>(nodes: ReadonlyMap<string, GraphNode<Meta>>, names: Iterable<string>) {
  const kept = new Set<string>();
  const visit = (name: string) => {
    if (kept.has(name)) return;
    const found = nodes.get(name);
    if (!found) throw new Error(`closure: the graph holds no node "${name}"`);
    kept.add(name);
    found.node.deps.forEach(visit);
  };
  for (const name of names) visit(name);
  return new Map([...nodes].filter(([name]) => kept.has(name)));
}

/** A graph's nodes; a subgraph's are those under its prefix and every node they depend on. */
export const graphNodes = <Ports, Meta>(
  graph: Graph<Ports, Meta>,
): ReadonlyMap<string, GraphNode<Meta>> => {
  const { nodes, prefix } = stateOf(graph);
  if (!prefix) return nodes;
  return withDeps(
    nodes,
    [...nodes.keys()].filter((name) => name.startsWith(`${prefix}:`)),
  );
};

/** Add a node: its `params` as declared, and its own inputs, as given or as its function returns them. */
export function addNode<R extends Outputs, Ports, Meta>(
  graph: Graph<Ports, Meta>,
  spec: ErasedSpec,
  params: { name?: string; meta?: Meta; deps?: DepRecord | undefined },
  inputsOf: () => InputRecord<unknown> | undefined,
): NodeRef<R> {
  const state = stateOf(graph);
  const own = params.name ?? spec.kind;
  const name = state.prefix ? `${state.prefix}:${own}` : own;
  const where = `node "${name}"`;
  if (state.nodes.has(name))
    throw new Error(
      `Duplicate node name "${name}". Names are unique in a graph: give the node a name of its ` +
        `own, or add it through graph.subgraph(prefix, meta).`,
    );

  const given = params.deps ?? {};
  for (const role of spec.requiredRoles)
    if (!(Object.hasOwn(given, role) && given[role]))
      throw new Error(
        `${where}: deps.${role} is ${Object.hasOwn(given, role) ? "undefined" : "missing"}, but ` +
          `its action "${spec.kind}" requires it. Add that node first and give its ref.`,
      );
  const roles = Object.entries(params.deps ?? {}).flatMap(([role, ref]) =>
    ref ? [[role, ref] as const] : [],
  );
  for (const [role, ref] of roles)
    if (!state.nodes.has(ref.name))
      throw new Error(
        `${where}: deps.${role} is "${ref.name}", which this graph does not hold. Add that node first.`,
      );
  // Two roles may name one node: it is one dep, and required if either role requires it.
  const deps = [...new Set(roles.map(([, ref]) => ref.name))];
  const required = new Set(roles.filter(([, ref]) => !ref.settled).map(([, ref]) => ref.name));
  const settledDeps = deps.filter((dep) => !required.has(dep));

  const ownInputs = checkInputs(inputsOf, where);
  const redeclared = Object.keys(ownInputs).filter((k) => Object.hasOwn(spec.inputs, k));
  if (redeclared.length > 0)
    throw new Error(
      `${where}: inputs.${redeclared[0]} is declared by its action "${spec.kind}". Give the ` +
        `node's input another name.`,
    );
  const inputs = { ...spec.inputs, ...ownInputs };

  const meta = params.meta === undefined ? state.meta : params.meta;
  const node: Node<Meta> = {
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
  names: Iterable<string> & object,
): Graph<Ports, Meta> {
  const result = new Graph<Ports, Meta>();
  stateOf(result).nodes = withDeps(graphNodes(graph), names);
  return result;
}
