<div align="center">

# dagraph

**Directed Acyclic Action Graph. _Da graph._**

[![npm](https://img.shields.io/npm/v/@mrmeku/dagraph.svg)](https://www.npmjs.com/package/@mrmeku/dagraph)
[![CI](https://github.com/mrmeku/dag/actions/workflows/ci.yml/badge.svg)](https://github.com/mrmeku/dag/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/@mrmeku/dagraph.svg)](https://github.com/mrmeku/dag/blob/main/LICENSE)

</div>

## Why dagraph

You got jobs. Jobs got dependencies. Somebody's gotta keep track of who owes what to who. dagraph runs file-producing work as a graph, and it skips every job whose answer is already on disk. Three things make it worth your while:

- **Nobody does the same job twice.** Each job gets a cache key from its config, the files it reads and the outputs of its dependencies. If the cache has a result for that key and its files are unchanged, the job does not run. A job that runs again and makes the same files stops there.
- **Jobs start as soon as they can.** A job starts when its dependencies finish, within the limits you set. A finished fetch starts its transform next, ahead of fetches from other branches.
- **The compiler enforces the graph shape.** Each dependency carries its job's output type. Connect the wrong job, and TypeScript reports it before anything runs.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Features](#features)
- [How it works](#how-it-works)
- [The rules of the family](#the-rules-of-the-family)
- [Compared to other tools](#compared-to-other-tools)
- [Documentation](#documentation)

## Install

```sh
npm install @mrmeku/dagraph
```

dagraph runs on Node 22 or later, and on Bun.

## Quick start

Two jobs. `count` counts the words in `notes.txt`. `report` writes them up. `report` needs what `count` made, so that's the edge.

```typescript
import { readFile, writeFile } from "node:fs/promises";
import { defineAction, execute, FsCache, Graph, type NodeRef } from "@mrmeku/dagraph";
import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";

const tools = { readFile, writeFile };

const count = defineAction<typeof tools, { kind: "count"; inputs: string[] }, string>({
  config: "v1",
  action: (t) => async (params, _inputs, outputDir) => {
    const text = await t.readFile(params.inputs[0]!, "utf8");
    const out = `${outputDir}/count.txt`;
    await t.writeFile(out, String(text.split(/\s+/).filter(Boolean).length));
    return out;
  },
});

const report = defineAction<
  typeof tools,
  { kind: "report"; deps: { count: NodeRef<string> } },
  string
>({
  config: "v1",
  action: (t) => async (_params, inputs, outputDir) => {
    const out = `${outputDir}/report.md`;
    await t.writeFile(out, `# Report\n\n${await t.readFile(inputs.count, "utf8")} words\n`);
    return out;
  },
});

const graph = new Graph();
const words = count.addNode(graph, tools, { kind: "count", inputs: ["notes.txt"] });
report.addNode(graph, tools, { kind: "report", deps: { count: words } });

const fs = createNodeDagFs();
const results = await execute(graph, {
  cache: new FsCache(".dagraph", fs),
  fs,
  casBaseDir: ".dagraph",
});
for (const result of results) console.log(result.name, result.status);
```

Run it once. Both jobs get done:

```
count done
report done
```

Run it again. Nobody lifts a finger:

```
count cached
report cached
```

Now change a word in `notes.txt`, but keep the count the same. `count` goes back to work, because its input changed. It comes back with the same number, so `report` stays home:

```
count done
report cached
```

## Features

- **Typed dependencies.** `NodeRef<T>` carries the output type of a job. Wire the wrong job into a slot and the compiler tells you before anything runs. [Graphs](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/graphs.md)
- **A content-addressed cache.** A job runs again only when its config, its input files or its dependencies' outputs change. Before it trusts a cached answer, da graph hashes the files again. [Caching](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/caching.md)
- **Early cutoff.** A job that runs again and makes the same files does not send its dependents back to work.
- **Optional dependencies.** A job can run without a dependency that failed, and runs again once that dependency comes through. [Graphs](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/graphs.md#optional-dependencies)
- **Limits.** Cap how many jobs run at once, in total and for each group, or write your own scheduler. [Execution](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/execution.md#schedulers)
- **Timeouts and cancellation.** Each job gets an `AbortSignal`. A job that ran out of time fails; a job you called off is cancelled. Neither is cached. [Execution](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/execution.md#timeouts-and-cancellation)
- **Events and output.** Every state change and every line a job prints comes to your callbacks, for progress bars, logs and live checks. [Execution](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/execution.md#events-and-output)
- **Jobs anywhere.** A node's description is plain data. Run each job in another process with `processNode`, and keep the scheduling with `orchestrate`. [Runners](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/runners.md)
- **Diagrams.** `mermaidBody` draws the graph as a Mermaid flowchart. [Graphs](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/graphs.md#draw-a-graph)

## How it works

Every job in da graph is a node. A node takes files in, writes files out, and gets a key that says exactly what it did.

| Term       | Meaning                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| Action     | A kind of work, defined once with `defineAction`. It holds the config and the function that does the work.          |
| Node       | One job in the graph: an action with its parameters. Its name is its `kind`.                                        |
| Dependency | A node whose outputs another node needs. Put its `NodeRef` in `deps`.                                               |
| Input      | A file outside the graph that a node reads. List it in `inputs`.                                                    |
| Output     | The file paths that a node's action returns, written to its own output directory.                                   |
| Action key | A hash of the node's name, its config, the content hashes of its dependencies and the content hashes of its inputs. |
| CAS        | The content-addressed store: each node's outputs under `<casBaseDir>/<action key>/out`.                             |

Before a node runs, da graph calculates its action key. If the cache has an entry for the key and the files still hash the same, the node does not run.

The keys form a Merkle tree. Change one input, and the key of every node downstream changes with it. But if a node runs again and makes the same files, the chain stops there.

## The rules of the family

The engine stays small by one rule: **if a node could do it, add a node.**

A check, for example, is a node. It reads another node's outputs and writes the defects it finds. It is cached by its subject's content, so it runs once for each version of the subject. The engine does not know it is a check, and it does not need to.

A new primitive gets in only when a node cannot do the job without breaking the one contract: a node's key covers everything that decides its output. `optional()`, `cacheable: false`, `force`, `cacheOnly`, `inputs` and `normalize` each made it in that way. Nothing else did.

When in doubt, build it as a node first. If it works, it was never a primitive. See [Design](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/design.md).

## Compared to other tools

- **[Make](https://www.gnu.org/software/make/)** decides what to rebuild from file timestamps. dagraph decides from content hashes, so a touched file with the same content changes nothing, and an output that comes back the same stops the rebuild.
- **[Turborepo](https://turborepo.com) and [Nx](https://nx.dev)** run the scripts of a monorepo from a config file. dagraph is a library: the graph is TypeScript, and a node is any async function that writes files.
- **[Bazel](https://bazel.build)** runs hermetic builds from rules in its own language, with sandboxes and remote execution. dagraph has no sandbox and no build language. It keys on what you declare, and trusts you to declare it.
- **[p-graph](https://github.com/microsoft/p-graph)** runs a graph of promises with a concurrency limit. dagraph adds the cache, typed dependencies, timeouts and cancellation.

[dagactions](https://github.com/mrmeku/dag/tree/main/packages/dagactions) is da graph's own crew: a CI runner that runs a GitHub Actions job as a dagraph graph.

## Documentation

- [Graphs](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/graphs.md): actions, nodes, dependencies, inputs, validation and diagrams.
- [Caching](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/caching.md): the action key, the caches, `normalize`, `cacheable`, `force` and `cacheOnly`.
- [Execution](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/execution.md): `execute`, file systems, schedulers, events, results, timeouts and cancellation.
- [Runners](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/runners.md): run nodes in other processes with `processNode` and `orchestrate`.
- [Design](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/design.md): what belongs in the engine, and what belongs in a node.

## License

[MIT](https://github.com/mrmeku/dag/blob/main/LICENSE)
