# Graphs

A graph is a set of nodes and the dependencies between them. You make it in three steps:

1. Define each kind of work once, with `defineAction`, bound to your ports by `actionsFor<Ports>()`.
2. Add one node for each job, with the action's `addNode`. Give each node the references to the nodes that it needs.
3. Give the graph to `execute`. See [Execution](execution.md).

The graph checks each node when you add it. A dependency must be in the graph before the node that needs it, so a graph cannot hold a cycle.

## Actions

An action is a kind of work. `defineAction` takes these fields:

| Field              | Meaning                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `kind`             | What kind of work it is, as Bazel's mnemonic. A label for display and routing. It is not part of the key.                      |
| `deps`             | Optional. The [dependencies](#dependencies) that each node gives, by role, and what each one returns.                          |
| `nodeInputs`       | Optional. The [inputs](#inputs) that each node gives when it is added, by name and type: `nodeInputs<{ width: number }>`.      |
| `inputs`           | Optional. The [inputs](#inputs) that every node of the action has, such as a version that names the action's logic.            |
| `action`           | `(actionContext) => Promise<outputs>`, the function that does the work. See [The action context](#the-action-context).         |
| `invalidateOn`     | Optional. Fingerprints for dependencies that the nodes read only in part. See [Caching](caching.md#read-part-of-a-dependency). |
| `cacheable`        | Optional. `false` runs the node in each execution. See [Caching](caching.md#run-a-node-each-time).                             |
| `concurrencyGroup` | Optional. The group that limits this action, with `throttledScheduler`. See [Execution](execution.md#schedulers).              |
| `timeoutMs`        | Optional. How long the action can run, from 1 to 2,147,483,647 ms. See [Execution](execution.md#timeouts-and-cancellation).    |

The last three fields tell how a node runs, not what it makes. None of them is part of the key.

Each type of an action comes from its fields: its dependencies from `deps`, its inputs from `nodeInputs` and `inputs`, and its outputs from what `action` returns. A field that names only a type takes a generic function uncalled, as `nodeInputs<{ width: number }>`: the engine reads the type and never calls it. Called, as `nodeInputs<{ width: number }>()`, it means the same. The one type that no field gives is the ports. Bind them once, with `actionsFor<Ports>()`, and use the function that it returns for each action. TypeScript cannot infer some type parameters of a call while you write the others, so the ports come in a call of their own. An action that needs no ports can use `defineAction` from the package.

```typescript
interface Ports {
  images: ImageTool;
}

const defineActionWithPorts = actionsFor<Ports>();

const resize = defineActionWithPorts({
  kind: "resize",
  deps: { source: fetch },
  nodeInputs: nodeInputs<{ width: number }>,
  inputs: { version: "resize-v1" },
  action: async ({ inputs, depOutputs, ports, outputDir }) => {
    const out = `${outputDir}/resized.jpg`;
    await ports.images.resize(depOutputs.source.path, out, inputs.width);
    return out;
  },
});
```

> [!IMPORTANT]
> Neither the action's function nor its `kind` is part of the key. Two actions that declare the same inputs and dependencies share one cache entry. Give each action a version input that names the action and its revision, such as `"resize-v1"`, and change it when the logic changes. A bare `{ version: 2 }` copied between two actions over the same dependencies can serve one action the files of the other.

### The action context

The action function gets one argument, the action context. Each part of it is keyed, a tool, or this attempt's own:

| Field        | Content                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `inputs`     | Each input, by name: a file as a [file handle](#file-handles), a value as written, with each [output ref](#output-refs) resolved. |
| `depOutputs` | The outputs of each dependency, by the role that `deps` gives it, as file handles in the shape of the outputs.                    |
| `ports`      | The tools from the execution context. See [Execution](execution.md#the-execution-context).                                        |
| `outputDir`  | The absolute path of a new, empty directory that only this attempt writes.                                                        |
| `signal`     | An `AbortSignal` that fires on the node's timeout or the execution's cancel.                                                      |
| `output`     | A function for the text that the action prints, in chunks as printed. It adds no line ending.                                     |

The action does not get the node's name or its `meta`. A value that decides the output reaches the action only as an input.

The function writes its files to `outputDir` and returns their paths: a path, a list of paths, or a record of paths and lists of paths. These are the node's outputs. A path can be absolute, as `outputDir` is, or relative to the working directory. The engine stores each one in the form of `casBaseDir`. See [Caching](caching.md#where-the-files-go).

> [!IMPORTANT]
> Write outputs only to `outputDir`. A returned path that is not under `outputDir` fails the node. So does a returned path with no file, and the error names the output and its file: `output "thumb" (audio.jpg) was not written`. The engine moves the directory after the action succeeds, so no output can hold its own absolute path or the path of another output. A file that names another output names it relative to itself.

### File handles

An action reads each file through a `FileHandle`: a file input, an output of a dependency, or an output that an output ref names. An [output ref](#output-refs) names an output before its node runs. A handle is the file itself, inside an action. Where the file is, the engine decides.

| Member     | Content                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| `path`     | The file's absolute path while the action runs. Give it to a command or a library that takes a path.         |
| `text()`   | The file's contents.                                                                                         |
| `json(is)` | The file's contents as JSON, checked by the type guard `is`. A file that `is` refuses throws, with its path. |

The handles have the shape of the outputs. `Handles<T>` gives their type for an output type `T`:

| The dependency returns      | Its role in `depOutputs` holds           |
| --------------------------- | ---------------------------------------- |
| A path                      | a `FileHandle`                           |
| A list of paths             | a list of `FileHandle`                   |
| A record of paths and lists | a record of handles and lists of handles |

The role of a settled dependency that did not succeed holds `undefined`, and so does a `maybe` role that the node left out. An `invalidateOn` fingerprint gets the same handles as the action.

In this graph, `entry` reads JSON from one output of `source`, gives the path of the other to `stat`, and reads the text of `caption`, a settled dependency that fails:

```typescript
import { stat, writeFile } from "node:fs/promises";
import { actionsFor, execute, Graph, MemCache, nodeInputs, settled } from "@mrmeku/dagraph";
import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";

const ports = { stat, writeFile };
type Ports = typeof ports;
const defineActionWithPorts = actionsFor<Ports>();

const isMeta = (value: unknown): value is { title: string } =>
  typeof value === "object" &&
  value !== null &&
  "title" in value &&
  typeof value.title === "string";

const source = defineActionWithPorts({
  kind: "source",
  nodeInputs: nodeInputs<{ title: string }>,
  inputs: { version: "source-v1" },
  action: async ({ inputs, ports, outputDir }) => {
    const fetched = { meta: `${outputDir}/meta.json`, image: `${outputDir}/image.jpg` };
    await ports.writeFile(fetched.meta, JSON.stringify({ title: inputs.title }));
    await ports.writeFile(fetched.image, "not really a jpeg");
    return fetched;
  },
});

const caption = defineActionWithPorts({
  kind: "caption",
  nodeInputs: nodeInputs<{ title: string }>,
  inputs: { version: "caption-v1" },
  action: async (): Promise<string> => {
    throw new Error("no caption yet");
  },
});

const entry = defineActionWithPorts({
  kind: "entry",
  deps: { source, caption: settled(caption) },
  inputs: { version: "entry-v1" },
  action: async ({ depOutputs, ports, outputDir }) => {
    const { title } = await depOutputs.source.meta.json(isMeta);
    const { size } = await ports.stat(depOutputs.source.image.path);
    const text = (await depOutputs.caption?.text()) ?? "no caption";
    const out = `${outputDir}/entry.txt`;
    await ports.writeFile(out, `${title}: ${size} bytes, ${text}\n`);
    return out;
  },
});

const graph = new Graph<Ports>();
const fetched = source.addNode(graph, { inputs: { title: "Dawn" } });
const captioned = caption.addNode(graph, { inputs: { title: "Dawn" } });
entry.addNode(graph, { deps: { source: fetched, caption: settled(captioned) } });

const fs = createNodeDagFs();
const context = { ports, cache: new MemCache(), fs, casBaseDir: ".dagraph" };
for (const result of await execute(graph, context)) console.log(result.name, result.status);
```

It prints `caption failed`, `source done` and `entry done`, and `entry.txt` holds `Dawn: 17 bytes, no caption`.

These rules apply:

- A handle is never part of a string. TypeScript refuses it in a template string, with `+`, and where a string goes. `String(handle)` and `JSON.stringify(handle)` compile, but they throw. To put a file in a string, use its path: `` `--input=${source.path}` ``.
- To tell a handle from a list or a record of handles, use `isFileHandle`. Never use `typeof`: the type of a handle is a symbol's, but the handle is an object.
- A handle's `path` changes with the machine and the working directory. Never key on it: build no `invalidateOn` fingerprint and no output's content from it. Otherwise a CAS restored elsewhere misses.

## Nodes

`addNode(graph, params)` adds one node and returns a `NodeRef<R>`. `params` holds only these four fields:

| Field    | Meaning                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------- |
| `name`   | The node's address. The default is the action's `kind`.                                                             |
| `deps`   | Its dependencies, in the roles that its action declares. See [Dependencies](#dependencies).                         |
| `inputs` | Its own inputs, added to the action's: a record, or a function of its deps that returns one. See [Inputs](#inputs). |
| `meta`   | Data about the node for the code that reads the graph. See [Metadata](#metadata).                                   |

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

An action declares its dependencies in `deps`, by role. Each node gives a `NodeRef` in each role. The role is the key of the dependency's outputs in `depOutputs`. A role holds one of these:

| Role                              | The node gives                                        | `depOutputs` holds          |
| --------------------------------- | ----------------------------------------------------- | --------------------------- |
| An action: `{ fetch }`            | A node of an action that returns what `fetch` returns | its handles                 |
| `dep<T>`                          | A node of any action that returns `T`                 | its handles                 |
| `settled(fetch)`, or `settled<T>` | `settled(ref)`, a node that it runs without           | its handles, or `undefined` |
| `maybe(fetch)`, or `maybe<T>`     | A node, `undefined`, or nothing                       | its handles, or `undefined` |

Name the action when one action fills the role, and call `settled` and `maybe` around it. When more than one action can fill the role, name its outputs instead: `dep<T>`, `settled<T>` or `maybe<T>`, uncalled, since each names only a type. Use these for a transcript from `transcribe` or from `captions`, or when a function makes the action, as a factory of actions does.

```typescript
const entry = defineActionWithPorts({
  kind: "entry",
  deps: { source: fetch, transcript: settled<{ srt: string }>, summary: maybe(summarize) },
  action: async ({ depOutputs }) => {
    // ...
  },
});
```

`NodeRef<T>` carries the output type of the node. If you give a node whose outputs are not what the role declares, the program does not compile. These do not compile either: a missing dependency, a role that the action does not declare in a `deps` literal, and a misspelt output in `depOutputs` or in a fingerprint.

> [!IMPORTANT]
> TypeScript refuses an extra property only in an object literal. A `deps` record that a variable holds can carry a role that the action does not declare, and that role joins the key. Write `deps` in the `addNode` call.

The key holds each dependency by its role, never by its node's name. Thus renaming a node changes no key, and swapping two dependencies between roles does. `deps` in the action declares types and roles only. The dependencies, and the key, come from the node's `deps`.

Two roles can refer to the same node. The node is then one dependency.

Code that knows a node only by its name, such as a selection of a graph, gets a reference from `nodeRefNamed(name)`. Its outputs are untyped. If the graph holds no node of that name, `addNode` refuses the dependency.

An action that takes a dependency in any role, such as a step that its caller wires, declares `deps` as a record of type `DepSpecs`, whose roles are each a `Dep`, a `SettledDep` or `undefined`, or an uncalled marker: `const anyRole: DepSpecs = {}`, then `deps: anyRole`. Each node then gives the roles that it names, and its `inputs` function gets the refs of those roles.

### Settled dependencies

A settled dependency is a dependency that the node can run without. Declare its role with `settled` in the action, `settled(captions)` or `settled<T>`, and wrap the node's reference in `settled()`:

```typescript
const entry = defineActionWithPorts({
  kind: "entry",
  deps: { captions: settled(captions) },
  action,
});
entry.addNode(graph, { deps: { captions: settled(captionsRef) } });
```

The node waits for a settled dependency to settle, as `Promise.allSettled` waits for each promise. If `captions` fails, `entry` runs, and `depOutputs.captions` is `undefined`. These rules apply:

- The key records a settled dependency that did not succeed as missing. The engine does not cache a failure, so a later execution runs `captions` again. When it succeeds, `entry` runs again with its output.
- A required dependency that did not succeed keeps its dependents from running. They settle `dep-failed`.
- A `NodeRef` cannot fill a `SettledRef` role, and a `SettledRef` cannot fill a required role.
- If two roles refer to the same node and one role is required, the dependency is required.

## Inputs

An input is something outside the graph that decides a node's output, under a name that the action reads it by. Each input is one of these:

| Input   | Example                              | The action reads                | The key holds                        |
| ------- | ------------------------------------ | ------------------------------- | ------------------------------------ |
| A file  | `file("bun.lock")`                   | a [handle](#file-handles) on it | its path and the hash of its content |
| A value | `2`, `"en"`, `{ languages: ["en"] }` | the value as written            | the value as JSON, with sorted keys  |

An action declares inputs for all its nodes in `inputs`, and the inputs that each node gives in `nodeInputs`. A node adds its own:

```typescript
const lint = defineActionWithPorts({
  kind: "lint",
  nodeInputs: nodeInputs<{ eslint: FileInput; lock: FileInput }>,
  inputs: { version: "lint-v1" },
  action,
});
lint.addNode(graph, { inputs: { eslint: file("eslint.config.ts"), lock: file("bun.lock") } });
```

These rules apply:

- A node gives each input that `nodeInputs` declares, of its type. A missing one does not compile.
- A node cannot declare an input again that its action declares. This does not compile. A record built at run time, as by `Object.fromEntries`, names no input in its type, so `addNode` refuses the repeat when the node is added.
- A node can add inputs that its action never reads. They change its key all the same.
- A value is JSON: a string, a finite number, a boolean, `null`, or an array or a plain record of these. Its type is `InputValue`. A value that is not JSON does not compile; the table below gives the right form. A property that is `undefined` is dropped.
- `file()` is its own input. It is never part of a value or of a string, as a [ref](#output-refs) is not, and its conversion to a string throws.
- An input is never another node. What comes from a node is a dependency.
- The engine hashes each file path as you give it. `execute` hashes each file once per execution, also when many nodes declare it. `processNode`, called alone, hashes the files of its one node. A file that cannot be read fails the node before it gets a key.

| Does not compile                        | Write instead                                                   |
| --------------------------------------- | --------------------------------------------------------------- |
| A `Map` or a `Set`                      | `Object.fromEntries(map)`, `[...set]`                           |
| A `Date`                                | `date.toISOString()`                                            |
| A `bigint`                              | `String(n)`                                                     |
| A function or a class instance          | The data that it holds, as a record                             |
| `undefined` as an item of a list        | `null`, or no item                                              |
| `{ tools: { lock: file("bun.lock") } }` | `{ lock: file("bun.lock") }`                                    |
| A node                                  | A dependency in `deps`, and a [ref](#output-refs) to its output |

No type can see `NaN`, `Infinity`, or an object that is not plain, such as a class instance whose type is a record's. The engine refuses each where it is declared, with its path and what to give instead, for example `inputs.ratio is NaN, which is not JSON. Give a finite number, or null.`

If a node reads something that it does not declare, a change to it does not run the node again.

## Output refs

A ref stands for a path that the engine fills in only when its node has run. Thus a ref is never a string, and it is never part of a string.

A value input can name an output of a dependency. To do this, give `inputs` as a function. It gets each dependency that `deps` declares, by its role, as a record of refs to that dependency's outputs. It returns the inputs, and it runs once, when the node is added:

```typescript
const pack = packAction.addNode(graph, {});
publish.addNode(graph, {
  deps: { pack },
  inputs: ({ pack }) => ({ argv: ["npm", "publish", pack.tarball] }),
});
```

A ref of a required dependency is an `OutputRef<T>`, where `T` is the type of that output. A ref of a settled dependency is a `SettledOutputRef<T>`. A dependency whose outputs are not a record has no refs.

A ref can be in a value input: the input itself, an item of an array or a property. The action reads it as a [handle](#file-handles) on the dependency's published file, or a list of handles for a list output. A ref of a settled dependency that did not succeed reads as `undefined`.

These rules apply:

- A ref names only a dependency that `deps` declares. A role that `deps` does not declare does not compile: `Property 'mirror' does not exist`.
- A ref goes only in what the function call that got it returns. A ref kept from the function of another node does not compile.
- A `SettledOutputRef` never fills an input that `nodeInputs` declares as an `OutputRef`, because it can be missing.
- The refs of a dependency cannot be listed, for example by a spread, because the names of its outputs exist only in the types. Name each output, as `pack.tarball`. A list of them throws when the node is added.
- In the key, a ref is the role it points through and the output's name. It never adds the path, so the key is the same wherever the files are. It never adds the dependency's content again, because the dependency's role holds it already. Thus an [`invalidateOn`](caching.md#read-part-of-a-dependency) fingerprint holds however the output reaches the action.
- A ref is never part of a string. Its type is a `symbol` whose `toString` and `valueOf` are `never`, so TypeScript refuses it in a template string, with `+`, where a string goes, and in `.toString()`. This applies to `NodeRef`, `SettledRef`, `OutputRef`, `SettledOutputRef` and `FileInput`.
- `String(ref)`, `JSON.stringify(ref)` and `[ref].join()` throw while the graph is built, before any node runs. The error says that a ref can't be part of a string, and how to give it.

```typescript
publish.addNode(graph, {
  deps: { pack },
  inputs: ({ pack }) => ({
    own: { tarball: pack.tarball }, // its own property: compiles
    cut: `--file=${pack.tarball}`, // TS2731: does not compile
  }),
});
```

Refs in values are for commands, whose command line is a value. An action that reads a file itself reads it from `depOutputs`.

## Validation

The engine throws an error when a declaration is wrong:

| Where          | Refused                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineAction` | A `timeoutMs` that is not a whole number from 1 to 2³¹−1, a value input that holds `NaN`, `Infinity` or an object that is not plain.                                                                                 |
| `addNode`      | A duplicate name; an unknown dependency; an input that the action declares, in a record built at run time; a value input that holds `NaN`, `Infinity` or an object that is not plain; a list of a dependency's refs. |

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
