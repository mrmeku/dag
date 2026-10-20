# Graphs

A graph is a set of nodes and the dependencies between them. You make it in three steps:

1. Define each kind of work once, with `defineAction`.
2. Add one node for each job, with the action's `addNode`. Give each node the references to the nodes that it needs.
3. Give the graph to `execute`. See [Execution](execution.md).

The graph checks each node when you add it. A dependency must be in the graph before the node that needs it, so a graph cannot hold a cycle.

## Actions

An action is a kind of work. `defineAction` takes these fields:

| Field              | Meaning                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `kind`             | What kind of work it is, as Bazel's mnemonic. A label for display and routing. It is not part of the key.                      |
| `inputs`           | Optional. The [inputs](#inputs) that every node of the action has, such as a version that names the action's logic.            |
| `action`           | `(actionContext) => Promise<outputs>`, the function that does the work. See [The action context](#the-action-context).         |
| `invalidateOn`     | Optional. Fingerprints for dependencies that the nodes read only in part. See [Caching](caching.md#read-part-of-a-dependency). |
| `cacheable`        | Optional. `false` runs the node in each execution. See [Caching](caching.md#run-a-node-each-time).                             |
| `concurrencyGroup` | Optional. The group that limits this action, with `throttledScheduler`. See [Execution](execution.md#schedulers).              |
| `timeoutMs`        | Optional. How long the action can run, from 1 to 2,147,483,647 ms. See [Execution](execution.md#timeouts-and-cancellation).    |

The last three fields tell how a node runs, not what it makes. None of them is part of the key.

`defineAction` has three type parameters: the ports type `Ports`, the parameters type `P`, and the output type `R`. `P` gives the nodes' dependencies and the inputs that each node must add. A fourth, optional type parameter gives the type of the action's own `inputs`.

```typescript
interface Ports {
  images: ImageTool;
}

const resize = defineAction<
  Ports,
  { deps: { source: NodeRef<string> }; inputs: { width: number } },
  string
>({
  kind: "resize",
  inputs: { version: "resize-v1" },
  action: async ({ inputs, depOutputs, ports, outputDir }) => {
    const out = `${outputDir}/resized.jpg`;
    await ports.images.resize(depOutputs.source, out, inputs.width);
    return out;
  },
});
```

> [!IMPORTANT]
> Neither the action's function nor its `kind` is part of the key. Two actions that declare the same inputs and dependencies share one cache entry. Give each action a version input that names the action and its revision, such as `"resize-v1"`, and change it when the logic changes. A bare `{ version: 2 }` copied between two actions over the same dependencies can serve one action the files of the other.

### The action context

The action function gets one argument, the action context. Each part of it is keyed, a tool, or this attempt's own:

| Field        | Content                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `inputs`     | Each input, by name: a file as its path, a value as written, with each [output ref](#output-refs) resolved. |
| `depOutputs` | The outputs of each dependency, by the role that `deps` gives it, with their types.                         |
| `ports`      | The tools from the execution context. See [Execution](execution.md#the-execution-context).                  |
| `outputDir`  | A new, empty directory that only this attempt writes.                                                       |
| `signal`     | An `AbortSignal` that fires on the node's timeout or the execution's cancel.                                |
| `output`     | A function for the text that the action prints, in chunks as printed. It adds no line ending.               |

The action does not get the node's name or its `meta`. A value that decides the output reaches the action only as an input.

The function writes its files to `outputDir` and returns their paths: a path, a list of paths, or a record of paths and lists of paths. These are the node's outputs.

> [!IMPORTANT]
> Write outputs only to `outputDir`. A returned path that is not under `outputDir` fails the node. The engine moves the directory after the action succeeds, so no output can hold its own absolute path or the path of another output. A file that names another output names it relative to itself.

## Nodes

`addNode(graph, params)` adds one node and returns a `NodeRef<R>`. `params` holds only these four fields. Any other field is refused:

| Field    | Meaning                                                                           |
| -------- | --------------------------------------------------------------------------------- |
| `name`   | The node's address. The default is the action's `kind`.                           |
| `deps`   | Its dependencies, by role. See [Dependencies](#dependencies).                     |
| `inputs` | Its own inputs, added to the action's. See [Inputs](#inputs).                     |
| `meta`   | Data about the node for the code that reads the graph. See [Metadata](#metadata). |

```typescript
const graph = new Graph<Ports>();
const source = fetch.addNode(graph, { inputs: { url } });
resize.addNode(graph, { deps: { source }, inputs: { width: 640 } });
```

A graph has two type parameters: the ports its actions need, and the metadata its nodes carry, `Graph<Ports, Meta>`. `addNode` accepts an action only when the graph's ports satisfy the action's. `new Graph()` holds actions that need no ports, and nodes with no metadata.

### Names and subgraphs

Each name must be unique in the graph. To add more than one node of the same kind, give each a name, or add each group through a subgraph. `graph.subgraph(prefix, meta)` returns a view of the graph that adds `prefix:` to the name of each node added through it:

```typescript
for (const id of imageIds) {
  const image = graph.subgraph(id, { image: id });
  const source = fetch.addNode(image, { inputs: { url: urlOf(id) } });
  resize.addNode(image, { deps: { source }, inputs: { width: 640 } });
}
```

These nodes have the names `<id>:fetch` and `<id>:resize`. A subgraph can contain subgraphs. `subgraph(prefix)` without `meta` gives its nodes the `meta` of the graph it was made from.

A name is an address only. It is not part of any key. Two nodes that declare the same work have the same key and share one entry. So a value that tells two nodes apart must be an input, not only a part of the name. In the example, each `fetch` has its own `url` input.

### Metadata

A node's `meta` is data about it for the code that reads the graph, such as `{ image: id }`. The engine does not read it, key it or check it. It passes it through `describe()` and the events. A node's `meta` is its `params.meta`. Without one, it is the `meta` of the innermost subgraph that gave one.

Read `meta` instead of parsing names: a node's image is `node.meta.image`, not the text before the colon.

## Dependencies

`deps` maps a role to a `NodeRef`. The role is the key of the dependency's outputs in `depOutputs`:

```typescript
type ResizeParams = { deps: { source: NodeRef<string> }; inputs: { width: number } };
```

`NodeRef<T>` carries the output type of the node. If you give a reference of a different type, the program does not compile.

The key holds each dependency by its role, never by its node's name. Thus renaming a node changes no key, and swapping two dependencies between roles does.

Two roles can refer to the same node. The node is then one dependency.

### Settled dependencies

A settled dependency is a dependency that the node can run without. Wrap its reference in `settled()`, and declare its role as `SettledRef<T>`:

```typescript
type EntryParams = { deps: { captions: SettledRef<string> } };
entry.addNode(graph, { deps: { captions: settled(captionsRef) } });
```

The node waits for a settled dependency to settle, as `Promise.allSettled` waits for each promise. If `captions` fails, `entry` runs, and `depOutputs.captions` is `undefined`. These rules apply:

- The key records a settled dependency that did not succeed as missing. The engine does not cache a failure, so a later execution runs `captions` again. When it succeeds, `entry` runs again with its output.
- A required dependency that did not succeed keeps its dependents from running. They settle `dep-failed`.
- A `NodeRef` cannot fill a `SettledRef` role, and a `SettledRef` cannot fill a required role.
- If two roles refer to the same node and one role is required, the dependency is required.

## Inputs

An input is something outside the graph that decides a node's output, under a name that the action reads it by. Each input is one of these:

| Input   | Example                              | The action reads     | The key holds                        |
| ------- | ------------------------------------ | -------------------- | ------------------------------------ |
| A file  | `file("bun.lock")`                   | its path, as given   | its path and the hash of its content |
| A value | `2`, `"en"`, `{ languages: ["en"] }` | the value as written | the value as JSON, with sorted keys  |

An action declares inputs for all its nodes, and a node adds its own:

```typescript
lint.addNode(graph, { inputs: { eslint: file("eslint.config.ts"), lock: file("bun.lock") } });
```

These rules apply:

- A node cannot declare an input again that its action declares.
- A node can add inputs that its action never reads. They change its key all the same.
- A value must be JSON. A `Map`, a `Set`, a class instance, a function, a `bigint`, `NaN` or `Infinity` is refused where it is declared, with its path, for example `inputs.limits is a Map`. A property that is `undefined` is dropped.
- `file()` is a whole input. It cannot be a part of a value.
- An input is never another node. What comes from a node is a dependency.
- The engine hashes each file path as you give it. `execute` hashes each file once per execution, also when many nodes declare it. `processNode`, called alone, hashes the files of its one node. A file that cannot be read fails the node before it gets a key.

If a node reads something that it does not declare, a change to it does not run the node again.

## Output refs

A node whose outputs are a record has a ref to each output: `pack.outputs.tarball` is an `OutputRef<T>`, where `T` is the type of that output. A settled reference has them too: `settled(pack).outputs.tarball` resolves to `T | undefined`.

A ref can be in a value input: the whole value, an item of an array or a property. The action reads it as the dependency's published path or paths. A ref to a settled dependency that did not succeed reads as `undefined`.

```typescript
const pack = packAction.addNode(graph, {});
publish.addNode(graph, {
  deps: { pack },
  inputs: { argv: ["npm", "publish", pack.outputs.tarball] },
});
```

These rules apply:

- Naming an output does not make a dependency. Declare the node in `deps`. A ref to a node that is not in `deps` is refused when the node is added.
- In the key, a ref is the role it points through and the output's name. It never adds the path, so the key is the same wherever the files are. It never adds the dependency's content again, because the dependency's role holds it already. Thus an [`invalidateOn`](caching.md#read-part-of-a-dependency) fingerprint holds however the output reaches the action.

Refs in values are for commands, whose command line is a value. An action that reads a file itself reads it from `depOutputs`.

## Validation

The engine throws an error when a declaration is wrong:

| Where          | Refused                                                                                                                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineAction` | `config` (use `inputs`), `normalize` (use `invalidateOn`), a `timeoutMs` that is not a whole number from 1 to 2³¹−1, inputs that are not a record of files and JSON values.                                                       |
| `addNode`      | A field other than `name`, `deps`, `inputs` and `meta`; a duplicate name; an unknown dependency; an input that the action declares; a ref to a node that is not in `deps`; inputs that are not a record of files and JSON values. |

## Inspect a graph

| Function                | Returns                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph.describe()`      | Each node as a `Node`, in the order added: its name, `kind`, `meta`, `deps`, `settledDeps` and its how-to-run fields. No action, inputs or fingerprints. |
| `closure(graph, names)` | The graph of the named nodes and every node that they depend on, settled dependencies included. A name that the graph does not hold is refused.          |

`describe()` is the one view of a graph. Its data can go to another process when its `meta` can. To count nodes by kind, group `describe()` by `kind`.

A key is local to its node. Each graph that holds a node with the same declaration gives it the same key, whatever its name. Thus executing `closure(graph, ["deploy"])` runs `deploy` and what it needs, and hits the entries that an execution of the whole graph wrote.

## Draw a graph

`mermaidBody(nodes, options)`, from `@mrmeku/dagraph/mermaid`, returns the lines of a Mermaid flowchart. You add the first line, for example `flowchart LR`:

```typescript
import { mermaidBody } from "@mrmeku/dagraph/mermaid";

const { lines } = mermaidBody(graph.describe(), { subgraphOf: (meta) => meta?.image ?? "" });
const chart = ["flowchart LR", ...lines].join("\n");
```

Each node is drawn under its full name. `subgraphOf` gives the box of a node from its `meta`. Without it, no node is boxed. A settled dependency is a dashed edge. Use `options` to change the labels, the box titles and the classes of the nodes. The helper reads only `describe()`, so you can copy it and change it.
