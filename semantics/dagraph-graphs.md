# dagraph: building graphs

## The problem and the core idea

A program that turns raw material into finished files (fetch a page, translate it, summarise it, publish a site) is a chain of steps. Each step is slow or costly, each reads what earlier steps wrote, and most steps produce the same thing as last time. You want to write each step once, wire many copies of it together, and have mistakes in the wiring caught as early as possible: at compile time if you can, otherwise the moment the wiring is written, and never halfway through a long run.

`@mrmeku/dagraph` splits this into two halves. This page covers the first: **declaring** the graph. Running it (scheduling, caching, results) belongs to the neighbouring domains [dagraph-execution](dagraph-execution.md) and [dagraph-caching](dagraph-caching.md).

The core idea: an **action** is a kind of work, defined once, with typed inputs, typed dependencies and typed outputs. A **node** is one use of an action in a **graph**, with that use's own inputs and the nodes it depends on. You add a node by calling the action's `addNode(graph, params)`. It returns a **ref**, a small typed handle that names the node, and you pass that ref to the nodes that depend on it. Since a node can only depend on refs that already exist, every graph is acyclic by construction. There is no cycle check because no cycle can be written.

Terms used throughout:

- **Action**: what `defineAction` (or a function made by `actionsFor`) returns. It keeps the kind, the declared deps and inputs, the function that does the work, and how the work should run (group, timeout, cacheable) to itself: the value exposes only `addNode(graph, params)`, and it can stand as a dep declaration in another action's `deps`. `fetchPage.kind` does not exist. To see a node's kind, read `graph.describe()`.
- **Kind**: a string that names the action's logic, like Bazel's mnemonic. It is part of every node's cache key.
- **Node**: one use of an action in a graph. It has a unique name.
- **Role**: the name under which an action reads one of its dependencies, such as `page` or `translation`. The action declares its roles, and each node fills them with refs.
- **Dep**: a node that another node depends on, given in one of its roles.
- **Ref** (`NodeRef<T>`): what `addNode` returns. It carries the node's name and, in its type only, the node's output type `T`.
- **Ports**: the program's tools (a filesystem, an HTTP client, a translator), handed to every action at run time. They are part of the execution context, not of the graph.
- **Meta**: free-form data a node carries for the program's own use, such as which page it belongs to. The engine passes it through and never interprets it.

Where it lives: `packages/dagraph/src/define-action.ts`, `src/graph/graph.ts`, `src/graph/types.ts`.

## The public surface at a glance

Main entry point `@mrmeku/dagraph` (graph-building part):

| Export                       | What it is                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `defineAction(spec)`         | Defines an action that needs no ports. Returns an `Action`.                                           |
| `actionsFor<Ports, Group>()` | Returns a `defineAction` bound to the program's `Ports` type and its allowed concurrency-group names. |
| `Graph<Ports, Meta>`         | The graph class. Methods: `subgraph(prefix, meta?)` and `describe()`.                                 |
| `closure(graph, names)`      | A new graph holding the named nodes and everything they depend on.                                    |
| `dep<T>`                     | Declares a role that more than one action can fill, by its output type.                               |
| `settled(...)`               | Marks a role, or a ref, as one the node runs without if that dep does not succeed.                    |
| `maybe(...)`                 | Marks a role that a node may leave out.                                                               |
| `nodeInputs<T>`              | Declares the inputs each node of the action must give, by name and type.                              |
| `file(path)`                 | A file input: the file's content becomes part of the key.                                             |
| `nodeRefNamed(name)`         | An untyped ref to a node known only by its name.                                                      |
| `requiredDeps(node)`         | A described node's deps minus its settled ones.                                                       |
| `namedOutput(outputs, name)` | Pick one path out of a node's outputs, or throw.                                                      |
| `isFileHandle(value)`        | Type guard: is a value a single file handle.                                                          |
| `notAString(value, refusal)` | Makes an object refuse every conversion to a string (described below).                                |

Types, each explained further in its section:

- `Action<Ports, R, D = {}, N = {}, I = {}>`: an action needing `Ports`, with outputs `R`, deps `D`, node inputs `N` and own inputs `I`. `Action<Ports, Record<never, never>>[]` accepts a portless action that returns no outputs.
- `ActionSpec`: what `defineAction` takes.
- `ActionContext<Ports = unknown, D = DepSpecs, I = Record<string, unknown>>`: what one call of the action gets; `I` is the action's inputs and its nodes' together.
- `NodeRef<T>`, `SettledRef<T>`: a ref to a node, plain or wrapped in `settled`. `T` defaults to `Outputs`.
- `OutputRef<T, S>`, `SettledOutputRef<T, S>`: a ref to one output of a dep, inside an `inputs` function. `S` is the scope of the call that received it, default `unknown`.
- `Dep<T>`, `SettledDep<T>`: what `dep<T>()` and `settled<T>()` (or `settled(action)`) return, a role declaration.
- `DepSpecs`: the type of an action's `deps` record; a record typed so takes any role.
- `DepSpecsOf<D>`: the declaration that matches the deps a node gives.
- `DepRecord`: `Record<string, NodeRef | SettledRef | undefined>`, the type of a deps object built at run time.
- `DepRefs<D, S>`: the argument of an `inputs` function.
- `InputValue<S = never>`, `InputRecord<S = never>`: a value input, and inputs by name. `S` is the scope of the `inputs` call whose refs they may hold; the default `never` holds no refs.
- `FileInput`: what `file(path)` returns. `FileHandle`, `Handles<T>`: how an action reads files.
- `InvalidateOn<Ports, D>`: the type of the `invalidateOn` field.
- `NodeInputsSpec<T>`: what `nodeInputs<T>()` returns.
- `NodeParams`: the params of `addNode`.
- `Node<Meta>`: a node as data, from `describe()`.
- `NotAString`: the type of a value that is never part of a string.
- `Outputs`: what an action returns. `OutputOf<X>`, `NodeRefOf<X>`: an action's (or a ref's, or a dep's) output type, and the type of a ref to one of its nodes.

Separate entry point `@mrmeku/dagraph/mermaid`: `mermaidBody(nodes, options?)`, `mermaidQuote(text)` and the type `MermaidOptions<Meta>`.

The main entry point also exports the execution, caching and filesystem APIs (`execute`, `lookupNode`, `runAction`, `processNode`, `orchestrate`, schedulers, caches, `createMemoryDagFs`, result types). Those belong to [dagraph-execution](dagraph-execution.md) and [dagraph-caching](dagraph-caching.md). This page uses `execute`, `MemCache` and `createMemoryDagFs` only in its examples.

### The package

- **Name and install.** The package is `@mrmeku/dagraph`, MIT-licensed: `npm install @mrmeku/dagraph` (or `bun add @mrmeku/dagraph`). It is released from the `mrmeku/dag` repository: a `v1.2.3` tag publishes version 1.2.3, and a prerelease version goes under npm's `next` dist-tag, so `latest` only ever moves to a real release.
- **Badges.** npm version `https://img.shields.io/npm/v/@mrmeku/dagraph`, linking to `https://www.npmjs.com/package/@mrmeku/dagraph`; CI `https://github.com/mrmeku/dag/actions/workflows/ci.yml/badge.svg`, linking to `https://github.com/mrmeku/dag/actions/workflows/ci.yml`; licence `https://img.shields.io/npm/l/@mrmeku/dagraph`, linking to `https://github.com/mrmeku/dag/blob/main/LICENSE`, the repository's root `LICENSE`.
- **What ships.** JavaScript compiled from the TypeScript sources, with declarations. Its only runtime dependencies are `js-sha256` (every hash) and `pathe` (path normalising).
- **Compiler settings a consumer needs.** The declarations name web globals such as `AbortSignal`. A program compiled with `lib` `ESNext` only, and neither `@types/node` nor Bun's types, gets `Cannot find name 'AbortSignal'` inside dagraph's declarations unless `skipLibCheck` is on. `lib` `DOM`, or the `node` or `bun` types, provide them.
- **Entry points.** Four: `@mrmeku/dagraph` (the engine, the caches, the memory filesystem, every type), `@mrmeku/dagraph/fs` (`createBunDagFs`), `@mrmeku/dagraph/fs/node` (`createNodeDagFs`) and `@mrmeku/dagraph/mermaid` (`mermaidBody`, `mermaidQuote`).
- **Runtimes.** Node and Bun. The engine itself uses no runtime-specific API; only the filesystem adapters do: `/fs/node` is built on `node:fs` and runs on Node (and on Bun, which implements `node:fs`), `/fs` is built on `Bun.file` and needs Bun. The package declares no `engines` field, and nothing else names a minimum Node or Bun version for it, so no supported range is stated (see Open questions); the `>=24.2` in `@mrmeku/dagworkflows` is that package's own. What the repository does run: its CI and release pin Node 24 and Bun 1.4.2. dagraph's own tests run under Bun (`bun test ./packages/dagraph`), and dagraph runs under Node 24 as the engine of dagworkflows, whose tests run with `node --test` and whose GitHub Action runs on `node24`. The build targets `ESNext`, so the shipped JavaScript is the sources' syntax as written, lowered and polyfilled for no older runtime. The newest features the sources use are ES2022's (class static blocks, `Object.hasOwn`, an error's `cause`), except for ES2024's `Map.groupBy` in `/mermaid`. The oldest Node that runs it is set by two globals, not by syntax. The engine calls the global `crypto.randomUUID()` to name each attempt's `tmp-<uuid>` directory and each `FsCache` manifest's temporary file, and Node has a global `crypto` without a flag from 19.0. `/mermaid` calls `Map.groupBy`, which Node has from 21.0. Verified on 2026-10-26 with the quick start as plain JavaScript (its two type annotations removed) against the packed package. Node 19.0.0 and 20.0.0 print its six lines. Node 18.0.0 and 18.20.8 settle every node that has to run `failed` with `ReferenceError: crypto is not defined`, and its dependents `dep-failed`. `mermaidBody` throws `TypeError: Map.groupBy is not a function or its return value is not iterable` on Node 20.0.0 and works on 21.0.0. These are the versions that run it, not a supported range (see Open questions). The worked example on [dagraph-caching](dagraph-caching.md) ("Quick start") was run against the packed package under Bun 1.4.4 and Node 22.18, 23.6, 24 and 25.
- **The sibling package.** `@mrmeku/dagworkflows`, a CI runner from the same repository, depends on `@mrmeku/dagraph` and runs its workflows as dagraph graphs.

Where it lives: `packages/dagraph/package.json`, `scripts/release.ts`, `scripts/pack.ts`, `packages/dagworkflows/package.json`, `tsconfig.json`, `scripts/checks.ts`, `.github/workflows/ci.yml`, `packages/dagraph/src/process-node.ts` and `packages/dagraph/src/cache.ts` (`crypto.randomUUID`), `packages/dagraph/src/mermaid.ts` (`Map.groupBy`).

## A worked example

This example type-checks under the repository's strict compiler settings and runs as shown. It has two pages, each fetched, translated (which may fail), and summarised.

```ts
import {
  actionsFor,
  createMemoryDagFs,
  execute,
  file,
  Graph,
  maybe,
  MemCache,
  nodeInputs,
  settled,
  type DagFs,
  type FileInput,
  type OutputRef,
} from "@mrmeku/dagraph";
import { mermaidBody } from "@mrmeku/dagraph/mermaid";

interface Ports {
  fs: DagFs;
}
const limits = { network: 2 };
const defineActionWithPorts = actionsFor<Ports, keyof typeof limits>();

const fetchPage = defineActionWithPorts({
  kind: "fetch",
  nodeInputs: nodeInputs<{ url: string }>,
  inputs: { version: 1 },
  concurrencyGroup: "network",
  action: async ({ inputs, outputDir, ports }) => {
    const html = `${outputDir}/page.html`;
    await ports.fs.writeText(html, `<p>${inputs.url}</p>`);
    return { html };
  },
});

const translate = defineActionWithPorts({
  kind: "translate",
  deps: { page: fetchPage },
  action: async ({ depOutputs, outputDir, ports }) => {
    const html = `${outputDir}/fr.html`;
    await ports.fs.writeText(html, (await depOutputs.page.html.text()).toUpperCase());
    return { html };
  },
});

const summarize = defineActionWithPorts({
  kind: "summarize",
  deps: { page: fetchPage, translation: settled(translate), notes: maybe<{ notes: string }> },
  nodeInputs: nodeInputs<{ style: FileInput; argv: (string | OutputRef<string>)[] }>,
  action: async ({ inputs, depOutputs, outputDir, ports }) => {
    const style = await inputs.style.text();
    const argv = inputs.argv.map((a) => (typeof a === "string" ? a : a.path));
    const translated = depOutputs.translation ? await depOutputs.translation.html.text() : "none";
    const summary = `${outputDir}/summary.txt`;
    await ports.fs.writeText(
      summary,
      [style, argv.length, translated, depOutputs.notes?.notes.path ?? "no notes"].join(" | "),
    );
    return { summary };
  },
});

type Meta = { page: string } | { site: true };
const graph = new Graph<Ports, Meta>();
for (const id of ["home", "about"]) {
  const pageGraph = graph.subgraph(id, { page: id });
  const page = fetchPage.addNode(pageGraph, { inputs: { url: `https://example.com/${id}` } });
  const translation = translate.addNode(pageGraph, { deps: { page } });
  summarize.addNode(pageGraph, {
    deps: { page, translation: settled(translation) },
    inputs: ({ page }) => ({ style: file("/style.txt"), argv: ["render", page.html] }),
  });
}

const fs = createMemoryDagFs({ "/style.txt": "terse" });
const results = await execute(graph, {
  ports: { fs },
  fs,
  cache: new MemCache(),
  casBaseDir: "/cas",
});
```

Walking through it:

1. `actionsFor<Ports, "network">()` binds the one type that cannot be inferred, the program's ports, and the list of group names. Every action defined through `defineActionWithPorts` gets `ports: Ports` in its context and may only join group `"network"`. A misspelt `"netwrok"` does not compile.
2. `fetchPage` declares that each node gives a `url` (`nodeInputs`). It also declares one input of its own, `version: 1`, which every node of it shares. Its outputs type is `{ html: string }`, inferred from what `action` returns.
3. `translate` declares the role `page`, filled by a node of `fetchPage`. Inside its action, `depOutputs.page.html` is a file handle on the fetched page.
4. `summarize` declares three roles. `page` is required. `translation` is settled: the node still runs if translation fails, and then sees `undefined`. `notes` is maybe: a node may leave it out, as these nodes do. It reads `inputs.style` as a handle on `/style.txt`, and `inputs.argv` as a list where each output ref has become a handle on the page file.
5. `graph.subgraph("home", { page: "home" })` is a view that names each node it adds `home:<name>` and gives it that meta. With no `name` in the params, a node is named after its kind, so the nodes are `home:fetch`, `home:translate`, `home:summarize`, and the same under `about:`.
6. The `inputs` function of each summarize node gets `{ page }` (refs to the outputs of the deps it was given) and puts `page.html`, an output ref, into an argv list. It runs once, while the node is added.

`graph.describe()` returns these nodes, in the order they were added:

```json
[
  {
    "name": "home:fetch",
    "kind": "fetch",
    "meta": { "page": "home" },
    "deps": [],
    "concurrencyGroup": "network"
  },
  {
    "name": "home:translate",
    "kind": "translate",
    "meta": { "page": "home" },
    "deps": ["home:fetch"]
  },
  {
    "name": "home:summarize",
    "kind": "summarize",
    "meta": { "page": "home" },
    "deps": ["home:fetch", "home:translate"],
    "settledDeps": ["home:translate"]
  },
  "…the same three under about:"
]
```

Running it, all six nodes succeed, and `home:summarize` writes `terse | 2 | <P>HTTPS://EXAMPLE.COM/HOME</P> | no notes`. If translate threw, both translate nodes would fail, and both summarize nodes would still run, with `depOutputs.translation` `undefined`.

## Actions

### `defineAction` and `actionsFor`

`defineAction(spec)` defines an action that needs no ports: its context's `ports` is typed `unknown`, and it may name no concurrency group. A program with tools binds its own once: `const defineActionWithPorts = actionsFor<Ports>()`, or `actionsFor<Ports, Group>()` to allow the group names in `Group`, usually `keyof typeof limits` over the `concurrencyLimits` given to `throttledScheduler` ([dagraph-execution](dagraph-execution.md)). Apart from `Ports` and `Group`, every type comes from the spec. You never write type arguments at the call.

### The spec (`ActionSpec`)

| Field              | Required | Meaning                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kind`             | yes      | A string naming the action's logic. It joins every node's key, so actions of two kinds never share a cache entry. Nodes of one kind that differ put what differs in their node inputs (`nodeInputs`), so one action serves them all.                                                                                                                               |
| `deps`             | no       | The roles each node fills, as a record (see Dependencies).                                                                                                                                                                                                                                                                                                         |
| `nodeInputs`       | no       | `nodeInputs<{ ... }>` (uncalled, or called: the same thing). The names and types of the inputs each node gives.                                                                                                                                                                                                                                                    |
| `inputs`           | no       | Inputs every node of the action shares, such as `{ version: 1 }`. Same value rules as node inputs. They are checked, and copied, when the action is defined.                                                                                                                                                                                                       |
| `action`           | yes      | `async (context) => outputs`. Does the work (see The action context).                                                                                                                                                                                                                                                                                              |
| `invalidateOn`     | no       | Per role, a function `(outputs, ports) => string \| Promise<string>` whose result stands in for that dep's content in the key. `outputs` is that one role's dep outputs as handles (`Handles<T>`, never `undefined`), not the whole `depOutputs` record: `invalidateOn: { page: (page) => page.html.hash() }`. Semantics in [dagraph-caching](dagraph-caching.md). |
| `cacheable`        | no       | `false` runs every node of the action in every execution, and its entry is never read or written ([dagraph-caching](dagraph-caching.md)). Default: cacheable.                                                                                                                                                                                                      |
| `concurrencyGroup` | no       | The group whose limit the node runs under with `throttledScheduler`. It must be one of the names given to `actionsFor`.                                                                                                                                                                                                                                            |
| `timeoutMs`        | no       | How long the action may run, counted from its start. It must be a whole number from 1 to 2147483647 (the longest delay `setTimeout` honours). It is not part of the key.                                                                                                                                                                                           |

What `defineAction` checks when it is called:

- `timeoutMs` out of range throws `RangeError: action "<kind>": timeoutMs must be a whole number of ms from 1 to 2147483647, got <value>`. Refused: 0, -1, 1.5, NaN, Infinity, 2147483648. Accepted: 1 and 2147483647.
- The action's own `inputs` go through the input value check (see Inputs), with the prefix `action "<kind>": `. For example: `action "i": inputs.ratio is NaN, which is not JSON. Give a finite number, or null.`

Nothing checks that two actions have different kinds. Two actions sharing a kind share key space.

### Outputs

An action returns its outputs (`Outputs`): a record of named outputs, each a path or a list of paths (`Record<string, string | string[]>`). One file is still a record of one output, `{ html }`, and an action with no outputs returns `{}`. Every path must lie under the context's `outputDir`. The engine enforces that and files the outputs away ([dagraph-execution](dagraph-execution.md), [dagraph-caching](dagraph-caching.md)). The output type `R` is exactly what the function returns, so `{ html }` gives `{ html: string }`, and a returned template literal is typed as a plain `string`, not a pattern type. `OutputOf<typeof fetchPage>` names an action's (or a ref's, or a dep's) output type. `NodeRefOf<typeof fetchPage>` names the type of a ref to one of its nodes.

Write only under `outputDir`. The directory is renamed after the action returns (from `tmp-<uuid>/` to `out-<contentHash>/`, [dagraph-caching](dagraph-caching.md)), so the absolute paths the action saw stop existing. The returned paths are rewritten for you; paths written _inside_ a file are not. A file that names another output of the same node (a playlist naming its segments, an index naming its pages) must name it relative to itself, never by its absolute path. Since the content hash covers each file's path relative to the output directory, two attempts that write the same relative names and bytes publish the same content.

### The action context (`ActionContext`)

Each call of the action gets one object:

- `inputs`: the action's own inputs and the node's, merged, each resolved. A `file()` input arrives as a `FileHandle`. An output ref inside a value arrives as a handle, or a list of handles if that output is a list. A settled output ref arrives as `undefined` when its dep did not succeed. Everything else arrives as the JSON value it was declared as.
- `depOutputs`: each role's dep outputs, by role, as a record of handles: a handle for a path, a list of handles for a list. A settled role whose dep did not succeed, or a maybe role the node left out, is `undefined`, and its type includes `| undefined`, so the compiler makes the action check before reading.
- `ports`: the program's ports, from the execution context.
- `outputDir`: the absolute path of a new, empty directory that only this attempt writes.
- `signal`: an `AbortSignal` that fires on the node's timeout (reason a `TimeoutError`) or when the execution is cancelled.
- `output(chunk)`: reports text the action prints, delivered as `output` events ([dagraph-execution](dagraph-execution.md)).

That is all the action gets. It does not get its node's name, its meta, the graph, the cache or the CAS directory: anything an action needs to know must reach it as an input, a dep or a port, which keeps what the action can see and what the key covers the same thing.

Only `inputs` and `depOutputs` affect the key ([dagraph-caching](dagraph-caching.md)). The action function itself does not, so changing an action's logic means changing one of its inputs, for example bumping `version`.

Where it lives: `src/define-action.ts`, `src/graph/types.ts` (`ActionContext`, `Outputs`), `src/process-node.ts` (how the context is filled).

## Graphs, nodes and names

`new Graph<Ports, Meta>()` creates an empty graph. The defaults are `Ports = unknown` and `Meta = undefined`. `Ports` is the set of tools the graph's actions may need, and `Meta` is the type of the meta its nodes carry. Its public methods are `subgraph` and `describe`. Nodes are added through an action, never through the graph: `action.addNode(graph, params)`.

### `addNode` params (`NodeParams`)

The params object accepts these keys and no others (an extra key such as `kind` or `pageId` does not compile):

- `name?`: the node's own name. Default: the action's `kind`.
- `meta?`: this node's meta. Default: the meta of the subgraph view it is added through.
- `deps`: the refs that fill the action's roles. Required when the action has a required role. Optional, and must be empty, when the action declares none.
- `inputs`: the node's own inputs, either a record or a function of its deps' refs (see Inputs). Required when `nodeInputs` declares a required field.

It returns a `NodeRef<R>`, where `R` is the action's output type.

### Names

A node's full name is its own name, prefixed by the subgraph path it was added through, joined with `:` (for example `v2:parts:download`). Names are unique within a graph. Adding a second node with the same full name throws:

`Duplicate node name "download". Names are unique in a graph: give the node a name of its own, or add it through graph.subgraph(prefix, meta).`

So two nodes of one action in the same scope need explicit names. A name may itself contain `:` (`name: "b:c"` in subgraph `a` gives `a:b:c`). Nothing forbids that, and such a node then counts as under prefix `a:b` too.

The name is not part of the key, and neither is meta ([dagraph-caching](dagraph-caching.md)). Renaming nodes re-keys nothing.

### Subgraphs and meta

`graph.subgraph(prefix, meta?)` returns a view of the same graph, not a copy:

- A node added through the view is named `prefix:<name>` and is added to the one shared graph. Nested views join their prefixes: `graph.subgraph("v2").subgraph("parts")` names nodes `v2:parts:<name>`.
- An empty prefix on the root graph, `graph.subgraph("")`, is the root graph under another name: its nodes get no prefix, and its `describe()` and executions cover the whole graph. Under a non-empty parent, an empty prefix leaves an empty name segment: `graph.subgraph("a").subgraph("")` names nodes `a::<name>`.
- The view gives each node its `meta`, unless the node gives its own. Without `meta`, the view inherits its parent view's meta. Only `undefined` means "inherit". When the graph's `Meta` type includes `null` or another sentinel, a node or view can give that value to override an inherited meta, and `describe()` then shows it. What cannot be had under a view with meta is a node with no `meta` field at all.
- The view's `describe()`, and executing the view, cover the nodes whose names start with `prefix:` plus every node they depend on, transitively, inside the prefix or not. These come in the order the nodes were added. Matching is on `prefix:`, so view `v1` does not include `v10:...`.
- A ref given in `deps` may point to any node of the whole graph, not just the view.

Meta is where a program keeps what a node is about (the page, the site), so that a listener, a scheduler or a diagram can group nodes. Read it from `meta` (on `describe()`'s nodes, on every event, and on `Ready` entries), not by parsing names: a name's prefix depends on how deeply the node was nested, and a name may itself contain `:`.

A loop over items is the usual use of subgraphs:

```ts
for (const id of pageIds) {
  const pageGraph = graph.subgraph(id, { pageId: id });
  const page = fetchPage.addNode(pageGraph, { inputs: { url: id } });
  translate.addNode(pageGraph, { deps: { page } });
}
```

With actions of kinds `fetch` and `translate`, this names the nodes `<id>:fetch` and `<id>:translate` (a node is named after its kind by default) and gives each `{ pageId: id }` as meta, so one action can be used once per item with no explicit names.

Example: in a graph with `v1:*` and `v10:*` nodes and a root node `shared` that `v1:extra` depends on, `graph.subgraph("v1").describe()` names `v1:fetch, v1:translate, v1:summarize, shared, v1:extra`.

### `describe()`

`describe()` is the one view of a graph as data. It returns an array of `Node<Meta>` in the order the nodes were added. Each holds:

- `name`: the full name.
- `kind`.
- `meta`: present only when defined.
- `deps`: the names of the nodes it depends on, each once, at its first appearance in the node's `deps` object (that object's key order, not the order in which the action declares its roles). Roles given as `undefined`, such as a maybe role, are skipped.
- `settledDeps`: present only when non-empty. The deps it runs without.
- `concurrencyGroup`: present only when set.
- `cacheable`: present only when `false`.
- `timeoutMs`: present only when set.

It never holds the action, the inputs, or fingerprints, so a `Node` can be sent to orchestration in another process or a sandbox whenever its meta can. Besides `meta`, every field is a string, an array of strings, `false` or a whole number, and a field that would be `undefined` is left out, so node data comes back from `JSON.parse(JSON.stringify(nodes))` deep-equal whenever its meta survives JSON (verified, `meta: null` included). A meta that does not survive changes on the way: a `Date` comes back as its ISO string, a `Map` as `{}`, an `undefined` array item as `null`, and a `bigint` makes `JSON.stringify` throw. The arrays are fresh copies: pushing to a returned `deps` changes nothing in the graph. `requiredDeps(node)` gives `deps` minus `settledDeps`.

### `closure(graph, names)`

Returns a new, separate `Graph` holding the named nodes and every node they depend on, settled deps included. Each node is kept as declared, in the order it was added. Executing a closure runs part of a graph against the same cache entries, so nodes already run are hits. `names` is any iterable object of node names: an array, a `Set`, `map.keys()`. A bare string does not compile. An unknown name throws `closure: the graph holds no node "<name>"`. The closure of a subgraph view sees only that view's nodes: `closure(graph.subgraph("v1"), ["v10:entry"])` throws that error.

Where it lives: `src/graph/graph.ts`.

## Dependencies

### Declaring roles

An action's `deps` is a record from role name to a declaration:

- **An action**: `deps: { page: fetchPage }`. The role takes a node whose outputs have that action's output type.
- **`dep<T>`**: a role more than one action can fill, by output type alone: `deps: { image: dep<{ image: string }> }`. Write it uncalled. `dep<T>()` means the same. `dep()` with no type argument accepts any outputs.
- **`settled(x)`**: around an action, `settled(translate)`, or by type, `settled<{ srt: string }>`. The node runs whether or not that dep succeeds. Unlike `Promise.all`, it waits for the dep the way `Promise.allSettled` does. When the dep fails, is cancelled or is held back, the role's outputs are `undefined`.
- **`maybe(x)`**: around an action, `maybe(summarize)`, around a settled role, `maybe(settled(translate))`, or by type, `maybe<{ notes: string }>` (settled by type: `maybe(settled<{ notes: string }>())`). A node may leave this role out or give `undefined`. Its outputs are then `undefined`.
- **A record typed `DepSpecs`**: `const anyRole: DepSpecs = {}; deps: anyRole`. The action takes deps in any role, and each node names its own roles. This is how an aggregating node (an index over N pages) takes a variable number of deps: ``deps: Object.fromEntries(pages.map((p, i) => [`page${i}`, p]))``. The action's `depOutputs` is then typed by the declaration, not by what a node gives: every value is `{ [output: string]: FileHandle | FileHandle[] } | undefined`. So `value.out.text()` does not compile until the action narrows the value: checked for `undefined`, then `isFileHandle(value.out)` for a single handle (which also rules out a missing output) or `Array.isArray(value.out)` for a list. At run time a role whose dep did not succeed, or that the node gave as `undefined`, has no entry at all, so `Object.entries(depOutputs)` skips it.

Uncalled and called markers are the same: `settled<T>` and `settled<T>()`, `maybe<T>` and `maybe<T>()`, `nodeInputs<T>` and `nodeInputs<T>()`. The one exception is a marker given to `maybe`, which must be called: `maybe(settled<T>)` and `maybe(dep<T>)` do not compile, `maybe(settled<T>())` and `maybe(dep<T>())` do.

`DepSpecsOf<D>` goes the other way: from the deps a node gives (`{ rec: NodeRef<X> }`) to the declaration an action needs (`{ rec: Dep<X> }`). It is for an action defined for one particular node. Its members are called markers (`dep<X>()`), not uncalled ones.

### Giving deps on a node

A node gives each role a ref:

- a required role takes a plain `NodeRef<T>`, the value `addNode` returned;
- a settled role takes `settled(ref)`, a `SettledRef<T>`. A role declared one way takes no ref of the other: a plain ref in a settled role, or a settled ref in a required one, does not compile;
- a maybe role may be left out or given `undefined`. When the node gives it, it takes the ref of the role `maybe` wraps: a plain ref for `maybe(summarize)` or `maybe<T>`, and `settled(ref)` for `maybe(settled(translate))`, which the node then runs without as it would a settled role. The rule above holds inside `maybe` too: a settled ref in `maybe<T>`, or a plain ref in `maybe(settled(translate))`, does not compile. `maybe` marks only a role, never a ref: `maybe(ref)` does not compile.

The ref must carry the outputs its role declares. A node of the wrong action, or any node whose output record lacks the declared fields, does not compile. `nodeRefNamed(name)` builds an untyped ref (`NodeRef<Outputs>`) for a node known by name alone. It fits roles typed `dep()` or any-role actions, but not a role typed by a specific action.

### Two roles, one node

Two roles may name the same node. It is still one dep: it appears once in `deps` and runs the dependent once, with its outputs in both roles. It is required if any of its roles is required, so `{ main: ref, after: settled(ref) }` is held back (`dep-failed`) when `ref` fails.

### What is checked when a node is added

`addNode` checks in a fixed order: the name is not taken (see Names), the required roles are given, each ref names a node the graph holds, the inputs are built and checked (see Inputs), and no input redeclares one of the action's own. The node is stored only after all of them pass, so a refused `addNode` leaves the graph unchanged and can be retried once fixed. A name or deps failure comes before the `inputs` function is ever called. The two deps checks:

- Every required role must be present and defined. Otherwise:
  `node "<name>": deps.<role> is missing, but its action "<kind>" requires it. Add that node first and give its ref.`
  (or `is undefined` when the key is present but its value is `undefined`, typically a ref variable not yet assigned because steps run in the wrong order).
- Every given ref must name a node the graph already holds. Otherwise:
  `node "<name>": deps.<role> is "<ref name>", which this graph does not hold. Add that node first.`
  This check is by name, against the whole shared graph. A ref from another `Graph` instance whose name happens to exist here is accepted and binds to this graph's node of that name.

A role the action does not declare, a ref of the wrong output type, and a settled/required mismatch are caught only by the compiler. At run time an undeclared role is accepted: it becomes a dep, appears in `depOutputs`, and joins the key. Whether a dep is settled is read from the ref the node gives, never from the role: through a cast, a plain ref in a `settled` or `maybe(settled(...))` role makes the dep required, so the node is held back (`dep-failed`) when it fails, and a settled ref in a required role makes it settled.

Where it lives: `src/graph/types.ts` (`dep`, `settled`, `maybe`), `src/graph/graph.ts`.

## Inputs

A node's inputs are its action's own `inputs` merged with the node's. The key reads all of them by name ([dagraph-caching](dagraph-caching.md)).

### What an input can be

Each input (`InputRecord`) is one of:

- **A value input** (`InputValue`): a string, a finite number, a boolean, `null`, or an array or plain record of these, to any depth. The key holds it as JSON with sorted keys, so `{ a: 1, b: [1, 2] }` and `{ b: [1, 2], a: 1 }` key the same. A record property that is `undefined` is dropped, and so is a top-level input that is `undefined`. Array order matters.
- **A file input**: `file(path)`, and only ever as a whole input, never nested in a value. The path as given and the file's content hash join the key. The action reads it as a `FileHandle`. A file that cannot be read fails the node before it gets a key ([dagraph-caching](dagraph-caching.md)).
- **An output ref** (only inside the value an `inputs` function returns; see below).

The inputs are copied when they are checked, so changing the caller's object afterwards changes nothing.

These do not compile, and each has a right form:

| Wrong                          | Right                                                                    |
| ------------------------------ | ------------------------------------------------------------------------ |
| a `Map` / a `Set`              | `Object.fromEntries(map)` / `[...set]`                                   |
| a `Date`                       | `date.toISOString()`                                                     |
| a `bigint`                     | `String(n)`                                                              |
| a function or a class instance | the data it holds, as a plain record                                     |
| `undefined` as an array item   | `null`, or no item                                                       |
| `file()` nested inside a value | its own input: `inputs: { lock: file("bun.lock") }`                      |
| a node ref in a value          | a dep, declared in `deps`, with the output named in an `inputs` function |
| inputs given as a list         | a record                                                                 |

Some bad values no type can see: `NaN`, `Infinity`, a class instance typed as a record, and anything a narrower type hides (a function, symbol, bigint, or `undefined` list item inside an object typed `{ model: string }`). `defineAction` and `addNode` refuse these at run time, naming the path. The messages, each prefixed `node "<name>": ` (or `action "<kind>": `):

- `inputs.v.ratio is NaN, which is not JSON. Give a finite number, or null.` (also `Infinity`, `-Infinity`)
- `inputs.v.prompt is a Prompt, which is not JSON. Give a plain object of its fields: { ...prompt }.` (the `{ ...x }` hint appears only when the last path segment is an identifier, and "class instance" replaces the class name when none can be found)
- `inputs.style.format is a function, which is not JSON. Give the data it holds, as a record.`
- `inputs.style.tag is a symbol, which is not JSON. Give a string.`
- `inputs.style.size is a bigint, which is not JSON. Give a string: String(n).`
- `inputs.style.list[1] is undefined, which is not JSON in a list. Give null, or no item.` (only for an explicit `undefined` item)

When the types are bypassed, a `Map`, `Set` or `Date` gets the class-instance message: `inputs.m is a Map, which is not JSON. Give a plain object of its fields: { ...m }.`

Every error thrown while the inputs are built, by the value check or by the node's own `inputs` function, is re-thrown as a plain `Error` with the message `node "<name>": <message>`. The original class and `cause` are lost.

Run-time gaps and edge cases:

- A hole in a sparse array (`[1, , 3]`) is not refused, unlike an explicit `undefined`. It gets through as is and keys as `[1,,3]`, which is not JSON. The types refuse it.
- A cyclic value is not reported by path: it overflows the stack and throws `<where>: Maximum call stack size exceeded.`
- An object with a null prototype (`Object.create(null)`) counts as a plain record and is accepted.
- `-0` is kept as `-0` in what the action reads, and keys the same as `0`.

Input names that every object has, such as `constructor` or `toString`, are fine.

### Node inputs vs. the action's own

- With `nodeInputs<T>` declared, a node must give exactly the names of `T` with their types. A missing required input, a wrong type or a misspelt name (`langauge`) does not compile, even when the inputs come from a variable or from a function's return, where ordinary excess-property checks do not reach. Optional fields may be left out. If `T` is a union of records, a node gives every required name of at least one member, and may add names of any other member, even in a discriminated union: against `{ from: "web"; url: string } | { from: "disk"; path: string }`, `{ from: "disk", path: "a", url: "u" }` compiles. If `T` has an index signature (`Record<string, string>`), any name is allowed. `T` must be a type alias for a record, not an `interface`, which has no index signature.
- Without `nodeInputs`, a node may give any inputs. The action's context does not type them, though.
- A node may never redeclare one of the action's own `inputs`. That does not compile, and when the names are not visible to the type (inputs built at run time, or an action's inputs typed by an index signature), `addNode` throws:
  `node "<name>": inputs.<name> is declared by its action "<kind>". Give the node's input another name.`

`nodeInputs` is checked by the compiler only. At run time, a node that omits a declared input (when the types have been bypassed) is accepted, and its action sees `undefined`.

### The `inputs` function and output refs

`inputs` may be a function instead of a record: `inputs: ({ page }) => ({ argv: ["render", page.html] })`. It receives, for each dep the node gives, by role, an object of **output refs**, one per output of that dep. It runs once, synchronously, inside `addNode`. It is the only way to put a dep's output path into a value input, such as an argv list for a command, before that path exists.

The argument has an entry only for the roles the node actually gives: a maybe role left out, or given as `undefined`, is absent, and its type is `undefined`. For an action whose deps are typed `DepSpecs` (any role), the argument is typed by the deps the node gives.

- `page.html` is an `OutputRef<string>`, or `OutputRef<string[]>` for a list output. It is a `SettledOutputRef` when the role was given as `settled(ref)`. A settled ref never fits where an `OutputRef` is declared, because it may resolve to `undefined`.
- The action reads the ref as a handle on that output's published file, or a list of handles. A settled ref reads as `undefined` when its dep did not succeed.
- In the key, a ref is the role(s) it points through (all of them, sorted, when two roles name one node) plus the output's name. It is never the dep node's name and never a path. So an `invalidateOn` fingerprint on that role still governs it ([dagraph-caching](dagraph-caching.md)).
- Refs exist only for outputs every return of the dep includes. An optional output (`srt?: string`), or one named by an index signature, has no ref. Read it from `depOutputs`, where it is `| undefined`.
- The refs of a dep cannot be listed: a spread `{ ...page }`, or putting the whole `page` object in a value, throws `node "<name>": the refs of page cannot be listed: name each output, as page.<output>`. Their names exist only in the types.
- Refs are scoped to the call that received them: a ref kept from another node's `inputs` function does not compile in a different node's inputs.
- An output name that the dep turns out not to have at run time (possible only by bypassing types) fails the dependent node when it runs, with the error `"<dep node>" has no output "<name>"`.

Where it lives: `src/graph/inputs.ts`, `src/graph/types.ts` (`InputValue`, `InputRecord`, `DepRefs`, `file`).

## Values that are never part of a string

Refs, file inputs and file handles are objects whose paths are unknown, or machine-specific, when the graph is built. Gluing one into a string (`` `--file=${page.html}` ``) would silently key or run on garbage. So each refuses every conversion to a string:

- At compile time their type is a symbol's (`NotAString`), which TypeScript refuses in a template string (TS2731), with `+` (TS2469), and where a `string` is expected (TS2322).
- At run time `String(x)`, `` `${x}` ``, `[x].join()` and `JSON.stringify(x)` throw a `TypeError` that says what to do:
  - a node ref: `node "fetch" can't be part of a string. Put it in deps: deps: { fetch }.` A settled one ends `deps: { fetch: settled(fetch) }.` When the name is not an identifier (for example `v1:fetch`), it ends just `Put it in deps.`
  - an output ref: `page.html can't be part of a string: its path exists only once "fetch" has run. Make it its own array item or property: [..., page.html] or { html: page.html }.` The hint after the colon appears only when role and output are identifiers.
  - a file input: `file("bun.lock") can't be part of a string. Make it its own input: inputs: { "bun.lock": file("bun.lock") }.`
  - a file handle: `the handle on <absolute path> can't be part of a string. Use its .path.`

  In the output ref's message, the quoted dep is the dep node's full name (`"home:fetch"` under a subgraph). Output refs exist only inside a node's `inputs` function, and a refusal thrown there (by an output ref, or by a node ref or file input stringified there) reaches the caller of `addNode` as a plain `Error` prefixed `node "<name>": `, not as a `TypeError`.

Because the type says "symbol", never test for a handle with `typeof`. Use `isFileHandle`. `notAString(value, refusal)` is exported for a program that wants the same protection on its own objects. It installs throwing `toString`, `valueOf`, `toJSON` and `Symbol.toPrimitive` on `value` (mutating it) and returns it typed `T & NotAString`. The value must be extensible: a frozen, sealed or non-extensible object, or one where one of those four is already a non-configurable own property, makes `notAString` throw a `TypeError`.

Where it lives: `src/graph/types.ts` (`notAString`, `file`), `src/file-handle.ts`.

## File handles

A `FileHandle` is how an action sees any file it reads: a `file()` input, or an output of a dep. The engine owns where the file lives. A handle has:

- `path`: its absolute path while the action runs, for a command or library that takes a path. It differs by machine and working directory, so never build a fingerprint or an output's content from it.
- `text()`: the contents as UTF-8. If the file holds bytes that are not valid UTF-8, it throws `<path> is not UTF-8 text: decoding it lost bytes. Hash its bytes with hash().` A file that really contains U+FFFD reads fine.
- `json(is)`: the contents parsed and checked by the type guard `is`. It throws `<path> holds no JSON` (with the parse error as `cause`) or `<path> holds JSON that <guard function's name> refuses`. "its guard" replaces the name for an anonymous guard.
- `hash()`: the SHA-256 hex of its bytes, the same hash the engine uses for outputs. Use it as the fingerprint of a binary file.

`Handles<T>` maps an output record to its handles, field by field: a `string` becomes a `FileHandle`, a `string[]` a `FileHandle[]`, and an optional field stays `| undefined`. `isFileHandle(x)` is true only for a single handle, not for a list or record of them.

Where it lives: `src/file-handle.ts`, `src/graph/types.ts` (`FileHandle`, `Handles`).

## Output helpers

For code that reads a node's outputs back as data (results, cache entries), not as handles:

- `namedOutput(outputs, name)` returns the path the outputs hold as `name`. It throws `the node's outputs hold no path "<name>"` when there is none or when the field is a list.

Where it lives: `src/graph/types.ts`.

## Type-level guarantees

What the compiler stops, and so what a user can rely on not happening in code that type-checks without casts. Most items are pinned by `@ts-expect-error` lines in `src/graph.test.ts`, and the handle-in-a-string refusal in `src/dag.test.ts`. Two hold but no test pins them: a node's `meta` of the wrong type, and an `Action` retyped as taking other deps.

- **Ports**: an action defined with ports cannot be added to a graph whose `Ports` lack them, and `execute` refuses an execution context without satisfying `ports`. A portless action goes on any graph, and fits where an action needing more ports is expected. `Graph<Ports, Meta>` cannot be widened to another `Ports` or `Meta`. An `Action` cannot be retyped as needing fewer ports, other deps or other inputs.
- **Groups**: `concurrencyGroup` must be one of the names given to `actionsFor`. Plain `defineAction` takes none.
- **Roles**: a declaration must be an action, `dep`, `settled` or `maybe`. A ref or `{}` does not compile. A node cannot give an undeclared role (even through a variable), cannot omit a required one, cannot give a ref of the wrong output type, and cannot mix settled and required refs. `invalidateOn` takes only declared roles and sees their typed outputs.
- **Reading deps**: a misspelt output name (`depOutputs.page.hmtl`) does not compile. Reading a settled or maybe role without checking for `undefined` does not compile.
- **Inputs**: as listed under Inputs: JSON-only values, `file()` only whole, nodes only as deps, no redeclared action inputs, `nodeInputs` exact (missing, wrong type and misspelt names refused, even via variables and function returns).
- **Refs**: no ref in a string; no ref outside the call that received it; no settled ref where a required one is declared; no ref to an optional or index-signature output; `closure` takes an iterable object of names, not a bare string.
- **Meta**: a node's `meta` must be the graph's `Meta` type.

The run-time checks (duplicate names, required roles present, deps already in the graph, input values, redeclared inputs, `timeoutMs` range) catch what types cannot see or what a cast bypassed. They all fire while the graph is being built, before anything runs. One check fires later: an output ref (possible only through a cast) naming an output its dep did not return fails the node at execution, while its inputs are resolved, with `"<dep full name>" has no output "<output>"`.

## Drawing a graph: `@mrmeku/dagraph/mermaid`

A separate entry point that reads only `Node` data (from `describe()`) and is small enough to copy and adapt. It imports only a type and falls under the package's no-I/O lint rule, so like the index it is safe in Temporal's workflow sandbox.

`mermaidBody(nodes, options?)` returns `{ lines, id, subgraphs }`:

- `lines`: the body of a Mermaid flowchart, without the header. The caller adds `flowchart LR` (or `TD`), any `classDef`/`style` lines, and fences. In order:
  1. Node boxes, `  n<i>["label"]`, with ids `n0, n1, …` by position in `nodes`. When `subgraphOf` is given, nodes are grouped by its value, in order of each group's first appearance, even if a group's members are not adjacent. Each non-empty group becomes `  subgraph s<j> ["title"]`, its members indented four spaces, then `  end`. Nodes in group `""` are drawn unboxed, in their group's position.
  2. One edge per dependency, in node order then dep order: `  n0 --> n1`, or `  n1 -.-> n2` (dashed) when the dep is in the node's `settledDeps`.
  3. When `classOf` is given: one `  class n0,n2 <cls>` line per class, in order of first appearance. Nodes whose class is `undefined` or `""` get none.
- `id(name)`: the Mermaid id of a node by name, so a caller can style it or draw edges to its own pseudo-nodes. It throws `mermaidBody: unknown node "<name>"` for a name not in `nodes`.
- `subgraphs`: the subgraph ids, `s0, s1, …`.

Options (`MermaidOptions<Meta>`), all optional:

- `label(node)`: text in a node's box. Default: its full name.
- `subgraphOf(meta)`: the box a node goes in, computed from its meta; `""` for none. Without it, nothing is boxed.
- `subgraphLabel(subgraph, index)`: a box's title. `index` is the box's position among the drawn boxes, the `j` of its id `s<j>`; unboxed (`""`) groups do not count. Default: the subgraph value.
- `classOf(node)`: a class name per node. Default: none.

`mermaidQuote(text)` returns a Mermaid-safe quoted label. It replaces `#`, `"`, `<`, `>` and `` ` `` with numeric entities (`#35;`, `#34;`, `#60;`, `#62;`, `#96;`), and turns an empty label into `" "`, since Mermaid cannot parse `""`. Example: `say "hi"` becomes `"say #34;hi#34;"`. All labels and titles go through it.

Every dep of every node must itself be in `nodes`, or `mermaidBody` throws the unknown-node error. To draw a filtered set, drop the deps outside it first.

For the worked example, `["flowchart LR", ...mermaidBody(graph.describe(), { subgraphOf: (m) => (m && "page" in m ? m.page : ""), label: (n) => n.kind }).lines]` gives:

```
flowchart LR
  subgraph s0 ["home"]
    n0["fetch"]
    n1["translate"]
    n2["summarize"]
  end
  subgraph s1 ["about"]
    n3["fetch"]
    n4["translate"]
    n5["summarize"]
  end
  n0 --> n1
  n0 --> n2
  n1 -.-> n2
  n3 --> n4
  n3 --> n5
  n4 -.-> n5
```

Where it lives: `src/mermaid.ts`, `src/mermaid.test.ts`.

## What the engine knows, and what it leaves to nodes

The engine knows one thing: nodes. A node is a kind, inputs, deps by role, and a few fields on how to run it (`cacheable`, `concurrencyGroup`, `timeoutMs`). Everything a program does beyond that is either a node of its own or a choice made by the executor that runs the nodes ([dagraph-execution](dagraph-execution.md)).

**The primitives, and why each lives in the engine.** Each one does something a node cannot do for itself, because it acts before the node's action runs, or after it, or across nodes:

| Primitive                   | Why a node cannot do it                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Deps by role                | The engine must know the order to run nodes in, and the dep content each key covers.                                                             |
| `settled`                   | Holding a dependent back (`dep-failed`) is decided by orchestration before the dependent is ever processed, so a node cannot opt itself back in. |
| `maybe`                     | A role a node may leave out; it changes what is keyed (an absent role is not in the key) and what the action is typed to read.                   |
| `file()` inputs             | The file's content must be hashed into the key before the action runs.                                                                           |
| `invalidateOn`              | The key is computed before the action runs, and only the engine computes it.                                                                     |
| `cacheable: false`          | The cache lookup happens before the action, so the action cannot ask to skip it.                                                                 |
| `concurrencyGroup`          | Only a miss takes a slot, and only after its lookup; a node that limited itself would hold a slot during a hit.                                  |
| `timeoutMs`                 | The node must fail, and not be cached, whatever the action returns once the time is up.                                                          |
| `signal`, `waitForSlot`     | Choices about a whole execution or one node of it, made by whoever runs the graph.                                                               |
| An awaited `start` listener | Lets a journal record a start before the action has any effect.                                                                                  |

**What the engine does not know.** The package imports nothing but `js-sha256` and `pathe` (and, in the two filesystem adapters, `node:fs`, `node:path`, `node:crypto` or Bun's file API). So:

- it starts no processes and owns no terminal: a command is something an action runs through its ports;
- it knows no repository, branch or commit;
- it reads no environment variable;
- it knows no platform: no CI service, no workflow engine, no cloud;
- it holds no secrets: credentials reach actions through ports;
- it does not know what a node is for: meta is passed through and never read.

A lint rule in the repository's ESLint config covers every dagraph source file except the two filesystem adapters (published as `/fs` and `/fs/node`) and tests, so it covers the index and the `/mermaid` entry point. Test files are exempt, and the engine's tests do import both adapters. The rule has two patterns, each with its own message:

- an I/O module (`node:*`, `bun`, `fs` and every `fs/` subpath, `child_process`, `os`, `path`): `dagraph's index must reach no I/O module: Temporal bundles it into its workflow sandbox. Do I/O in a file system adapter, published as a subpath.`
- an adapter imported by a relative path: `dagraph's index must reach no I/O module: Temporal bundles it into its workflow sandbox. Import its file system adapters by their subpaths, outside the package.`

Separately, a rule over every package's sources, outside `src/ports/` and tests, refuses `node:fs`, `node:fs/promises`, `fs` and `fs/promises` with `Use the FileSystem port instead of direct fs imports.`

Where it lives: `packages/dagraph/package.json` (`dependencies`), `src/index.ts`, `eslint.config.ts`.

## Open questions

- **No minimum runtime version is declared.** `package.json` has no `engines` field, and neither has the published `0.3.0` (`npm view @mrmeku/dagraph engines` prints nothing, checked on 2026-10-26). CI pins Node 24 and Bun 1.4.2, the engine runs from Node 19.0 and `/mermaid` from 21.0 (see "The package"), and the quick start runs on Node 22.18 through 25 and Bun 1.4.4, but which Node and Bun versions are supported, and so what a reader may be promised, is not settled by the code. Should `engines` state a range, and should CI run the oldest one? One lower bound for Bun is known: under Bun 1.3.14 and earlier (tried from 1.3.1, on 2026-10-26), `JSON.stringify` skips the non-enumerable own `toJSON` that `notAString` installs on a plain object. So a node ref or a settled ref stringifies as `{"name":"download"}` (with `"settled":true`) instead of throwing, while output refs and file inputs still throw. From Bun 1.4.0 it throws, as on Node. Apart from this, the engine's tests fail on those versions only through a transpiler bug that touches the tests alone, covered in [dagworkflows-cli-action-release](dagworkflows-cli-action-release.md) ("Layout and tools").
- **No comparison with other tools or with a plain script.** The code compares dagraph with other tools only in passing: a kind is like Bazel's mnemonic, `throttledScheduler`'s limits are like Ninja's `-j` and its pools, and orchestration does no I/O so that it can run in a Temporal workflow's sandbox. Nothing in the code, its tests or the repository's public description (on GitHub, `DAG packages: @mrmeku/dagraph and @mrmeku/dagworkflows. Read-only export; see CONTRIBUTING.md.`, checked with `gh repo view mrmeku/dag` on 2026-10-26) says when dagraph is the better choice than a plain script that calls each step in turn, or than another build tool or workflow engine, beyond the problem statement at the top of this page and of [dagraph-caching](dagraph-caching.md) and [dagraph-execution](dagraph-execution.md). Is that problem statement the whole answer, or is there a comparison to state?
- **A nested `file()` or node ref slips through at run time.** The types refuse `file()` or a node ref inside a value, but the run-time check does not. When the types are bypassed (`any`, casts), `{ v: { lock: file("x"), dep: ref } }` is accepted, keyed and delivered to the action as `{ lock: {}, dep: { name: "rec" } }`. A file's content then never reaches the key. Is that intended, or should the run-time check refuse these by path, as it does a class instance?
- **Undeclared roles and missing `nodeInputs` are accepted at run time.** `addNode` checks only required roles and that refs exist. An extra role becomes a real dep and joins the key, and a missing declared node input reaches the action as `undefined`. Both are compile errors only. Should the run-time checks match?
- **Refs are bare names.** A ref from one `Graph` is accepted by another graph that has a node of the same name, and silently binds to it. Intended?
- **`describe()` copies arrays but not `meta`.** A caller who mutates a described node's meta object mutates the graph's. Harmless if meta is treated as read-only; worth stating or deep-copying.
- **No kind uniqueness.** Two different actions with the same `kind` and the same inputs would compute the same key for different logic. Nothing warns.
