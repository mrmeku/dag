# Graphs

A graph is a set of nodes and the dependencies between them. You make it in three steps:

1. Define each kind of work once, with `defineAction`.
2. Add one node for each job, with `addNode`. Give each node the references to the nodes that it needs.
3. Give the graph to `execute`. See [Execution](execution.md).

The graph checks each node when you add it. It checks for cycles before it runs.

## Actions

An action is a kind of work. `defineAction` takes these fields:

| Field              | Meaning                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `config`           | A string or an object that is part of the action key. Change it when the action's logic changes. An object is serialized with sorted keys. |
| `action`           | `(ctx, config) => async (params, inputs, outputDir, actionContext) => outputs`. See [The action function](#the-action-function).           |
| `concurrencyGroup` | The group that limits this action, with `throttledScheduler`. See [Execution](execution.md#schedulers).                                    |
| `cacheable`        | `false` runs the node each time. See [Caching](caching.md#run-a-node-each-time).                                                           |
| `timeoutMs`        | How long the action can run. See [Execution](execution.md#timeouts-and-cancellation).                                                      |
| `normalize`        | Fingerprints for dependencies that the action reads only part of. See [Caching](caching.md#read-part-of-a-dependency).                     |

`defineAction` has three type parameters: the context type `Ctx`, the parameters type `P`, and the output type `R`.

```typescript
const resize = defineAction<Ctx, ResizeParams, string>({
  config: "v1",
  action: (ctx) => async (params, inputs, outputDir) => {
    const out = `${outputDir}/resized.jpg`;
    await ctx.images.resize(inputs.source, out, params.width);
    return out;
  },
});
```

The result is an `Action`. It has two functions:

- `addNode(graph, ctx, params)` adds a node to a graph and returns a `NodeRef<R>`.
- `createAction(ctx)` returns the action function. Use it in tests, or to register the function in another process.

### Context and parameters

An action gets two types of values. Keep them separate:

- **The context (`ctx`)** holds the tools that the action uses: file systems, HTTP clients, command-line tools. You give it when you add the node.
- **The parameters (`params`)** hold only data that can be serialized: IDs, paths, prompts and dependency references.

This separation lets another process run the node. That process gets the parameters and uses its own context. See [Runners](runners.md).

### The action function

The action function gets four arguments:

| Argument        | Content                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------- |
| `params`        | The parameters of the node.                                                               |
| `inputs`        | The outputs of each dependency, by the role that `deps` gives it, with their types.       |
| `outputDir`     | The directory for the node's output files. The engine makes it.                           |
| `actionContext` | `signal`, an `AbortSignal`, and `output`, a function for the text that the action prints. |

The function writes its files to `outputDir` and returns their paths. The return type is `Outputs`: a path, a list of paths, or a record of paths and lists of paths.

> [!IMPORTANT]
> Write outputs only to `outputDir`. The engine hashes the returned files and stores the paths in the cache. Do not make paths from your own directories.

## Nodes

`addNode` adds one node. The node's name is the `kind` in its parameters:

```typescript
const graph = new Graph();
const source = fetch.addNode(graph, ctx, { kind: "fetch", url });
resize.addNode(graph, ctx, { kind: "resize", width: 640, deps: { source } });
```

Each name must be unique. To add more than one node of the same kind, add each group to a subgraph. A subgraph adds its prefix to each name:

```typescript
for (const id of imageIds) {
  const scope = graph.subgraph(id);
  const source = fetch.addNode(scope, ctx, { kind: "fetch", url: urlOf(id) });
  resize.addNode(scope, ctx, { kind: "resize", width: 640, deps: { source } });
}
```

These nodes have the names `<id>:fetch` and `<id>:resize`.

## Dependencies

`deps` maps a role to a `NodeRef`. The role is the key of the dependency's outputs in `inputs`:

```typescript
interface ResizeParams {
  kind: "resize";
  width: number;
  deps: { source: NodeRef<string> };
}
```

`NodeRef<T>` carries the output type of the node. If you give a reference of a different type, the program does not compile.

Two roles can refer to the same node. The node is then one dependency.

## Optional dependencies

An optional dependency is a dependency that the node can run without. Wrap its reference in `optional()`, and declare its role as `OptionalRef<T>`:

```typescript
interface EntryParams {
  kind: "entry";
  deps: { captions: OptionalRef<string> };
}
entry.addNode(graph, ctx, { kind: "entry", deps: { captions: optional(captionsRef) } });
```

If `captions` fails, `entry` runs, and `inputs.captions` is `undefined`. These rules apply:

- The engine does not cache a failure. A missing optional dependency is part of the action key. Thus a later execution runs `captions` again, and when it succeeds, `entry` runs again with its output.
- A `NodeRef` cannot fill an `OptionalRef` role, and an `OptionalRef` cannot fill a required role.
- If two roles refer to the same node and one role is required, the dependency is required.

## Inputs

`inputs` lists the files outside the graph that a node reads, for example source files or lockfiles. The content hash of each file is part of the action key:

```typescript
lint.addNode(graph, ctx, { kind: "lint", inputs: ["src/a.ts", "src/b.ts", "package.json"] });
```

The engine hashes each path as you give it. In one execution, it hashes each file only once, also when many nodes read it.

If a node reads a file that is not in `inputs`, a change to that file does not run the node again.

## Validation

The graph checks each node when you add it. It throws an error in these cases:

- A node with the same name exists. The error tells you how to use a subgraph.
- A dependency is not in the graph. Add each dependency before the nodes that need it.
- `timeoutMs` is not a whole number from 1 to 2,147,483,647.

`execute` and `graph.analyze()` check for cycles before they run anything. `validateNoCycles` does the same check alone.

## Inspect a graph

| Function           | Returns                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `graph.describe()` | Each node as a `Node`: data only, with no functions. You can send it to another process. |
| `graph.analyze()`  | The nodes, their total and the number of nodes of each kind. It also checks for cycles.  |
| `graph.getNodes()` | Each node with its action, by name.                                                      |

## Draw a graph

`mermaidBody(nodes, options)` returns the lines of a Mermaid flowchart. You add the first line, for example `flowchart LR`:

```typescript
const { lines } = mermaidBody(graph.describe());
const chart = ["flowchart LR", ...lines].join("\n");
```

Each subgraph prefix becomes a Mermaid subgraph. An optional dependency is a dashed edge. Use `options` to change the labels, the subgraphs and the classes of the nodes.
