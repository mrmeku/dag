# dagraph: executing graphs

## The problem, and the idea

A graph (see [dagraph-graphs](dagraph-graphs.md)) is a set of nodes, each one use of an action, wired by deps. Building it does nothing. Something has to walk it: start each node once its deps are done, skip the nodes whose earlier output is still good, run the rest, keep heavy work under a limit, stop cleanly on Ctrl-C, and tell the caller what happened to every node.

dagraph splits that walk in two halves:

- **Orchestration** decides _when_: it tracks which nodes are ready, asks a **scheduler** which of them to admit, hands each admitted node its deps' cache entries, and records how it settled. It works on nodes as plain data and does no I/O, so it can run inside a sandbox such as a Temporal workflow.
- **Processing** decides _what_: for one node it computes the action key, looks the key up in the cache, and on a miss runs the action and stores what it made (the key and the cache belong to [dagraph-caching](dagraph-caching.md)).

`execute` glues both halves together in one process. `orchestrate` and `processNode` are the two halves on their own, for an executor that processes nodes somewhere else.

Every node ends with exactly one **result**: plain data that says whether the node ran (`done`), was found in the cache (`cached`), failed (`failed`), was held back by a failed dep (`dep-failed`) or was cancelled (`cancelled`). A failure never stops the rest of the graph. Only the nodes that need the failed node are held back.

Terms used below:

| Term              | Meaning                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settle            | A node settles when it gets its result. It settles once.                                                                                                                                                |
| Ready             | A node is ready once every one of its deps has settled, whatever their results.                                                                                                                         |
| Dispatch          | Orchestration hands a ready node to processing.                                                                                                                                                         |
| Hit / miss        | Processing found a verified cache entry for the node's key, or did not.                                                                                                                                 |
| Start             | On a miss, the moment the action is about to run. A hit never starts.                                                                                                                                   |
| Place             | A unit of the scheduler's global limit (`maxParallelism`). A node holds one from dispatch until it settles, except that a miss in a concurrency group gives its place back while it waits for its slot. |
| Slot              | A unit of a concurrency group's limit. Only a miss in a group takes one, just before it starts.                                                                                                         |
| Execution         | One call of `execute` (or of `orchestrate`): one walk of a graph, from its first dispatch to its last result. Its options (`force`, `signal`, …) last for that call only.                               |
| Executor          | Whatever drives an execution: `execute` itself, or code of your own that calls `orchestrate` with a `RunNode`, for example one that processes nodes in worker processes or forces some nodes.           |
| Execution context | What the caller hands the engine: cache, file system, CAS directory and ports. It outlives any one execution.                                                                                           |

Where it lives: `packages/dagraph/src/execute.ts`, `orchestrate.ts`, `process-node.ts`.

## The public surface

All of these are exported from the package index, `@mrmeku/dagraph`:

| Name                                                              | Kind           | What it is                                                                      |
| ----------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------- |
| `execute(graph, executionContext, options?)`                      | function       | Runs a whole graph in this process. Resolves to one `Result` per node.          |
| `ExecuteOptions`                                                  | type           | `{ force?, onEvent?, scheduler?, signal? }`.                                    |
| `ExecutionContext<Ports>`                                         | type           | `{ cache, fs, casBaseDir, ports }`.                                             |
| `orchestrate(nodes, run, scheduler, onEvent?, signal?)`           | function       | The scheduling half, over node data. Resolves to one `Result` per node.         |
| `RunNode<Meta = unknown>`                                         | type           | The function `orchestrate` calls to process one node.                           |
| `processNode(graph, name, depEntries, executionContext, options)` | function       | The processing half, for one node. Resolves to its `Result`.                    |
| `ungated`                                                         | function       | The `acquire` gate that never waits, for `processNode` outside an orchestrator. |
| `NOT_CACHED`                                                      | constant       | `"not cached"`: the error message of a `cacheOnly` lookup that missed.          |
| `unboundedScheduler()`                                            | function       | The default scheduler: no limits.                                               |
| `throttledScheduler(options?)`                                    | function       | A scheduler with a global limit and one limit per concurrency group.            |
| `ThrottledSchedulerOptions`                                       | type           | `{ maxParallelism?, concurrencyLimits? }`.                                      |
| `Scheduler`, `SchedulerContext<Meta = unknown>`, `Ready<Meta>`    | types          | For writing a scheduler of your own.                                            |
| `Result`, `SucceededResult`, `FailedError`, `JsonValue`           | types          | A node's result and its parts.                                                  |
| `isResult(value)`, `isSucceeded(result)`                          | functions      | Type guards.                                                                    |
| `tally(results)`, `Tally`                                         | function, type | Counts results by status.                                                       |
| `ExecEvent<Meta = unknown>`, `ExecListener<Meta = unknown>`       | types          | The event stream and its listener.                                              |

The options object of `processNode` has no exported type name; its fields are listed in the `processNode` section. The file system implementations live on subpaths so that the index reaches no I/O module: `@mrmeku/dagraph/fs` exports `createBunDagFs()` (Bun) and `@mrmeku/dagraph/fs/node` exports `createNodeDagFs()` (Node). `createMemoryDagFs()`, an in-memory file system for tests, is exported from the index.

Where it lives: `packages/dagraph/src/index.ts`, `package.json` (`exports`).

## `execute`

`execute(graph, executionContext, options)` runs every node of `graph` in this process and resolves, once every node has settled, to an array of results, one per node, **in the order the nodes settled**. Under the default scheduler several nodes run at once, so that order can differ from run to run. Pass a subgraph view and only its nodes (with the nodes they depend on) are executed; that view is [dagraph-graphs](dagraph-graphs.md)'s.

`execute` does not reject because a node failed. A failure is a result like any other: inspect the results, for example with `tally`. It rejects in three cases only:

- A `dispatch` or `result` listener threw or rejected (see "Events and listeners"). A throw on `start` fails just that node.
- The scheduler itself threw or rejected, for example a bug in one passed as `options.scheduler`. `execute` rejects with that error and returns no results, while the nodes already dispatched keep running with nobody watching.
- The node data is broken (see `orchestrate`), which a `Graph` never produces.

The options, all optional:

| Option      | Default                | Effect                                                           |
| ----------- | ---------------------- | ---------------------------------------------------------------- |
| `force`     | `false`                | Every node skips its cache read, runs, and writes its new entry. |
| `onEvent`   | none                   | An `ExecListener` that receives every event of the execution.    |
| `scheduler` | `unboundedScheduler()` | The policy that admits ready nodes.                              |
| `signal`    | none                   | An `AbortSignal` that cancels the execution.                     |

### The execution context

`ExecutionContext<Ports>` has four fields:

- `cache`: a `Cache` (`FsCache`, `MemCache`, `TieredCache` or your own), where action keys map to entries.
- `fs`: a `DagFs`, the file system the engine reads, hashes and moves files with.
- `casBaseDir`: the directory under which each action key gets its own directory of outputs.
- `ports`: the tools the actions use, passed through to each action as `ports`. It is required when the graph's actions declare ports, and optional (and may be left out) when they need none.

The same context is meant to serve many executions: a CLI builds it once and executes graph after graph against it. Ports go in the context, never in the graph. The cache, the file system and the CAS layout are [dagraph-caching](dagraph-caching.md)'s.

Because ports arrive only through the context, the same graph runs against real tools in production and against stubs or mocks in a test: give the test's context a `ports` object of the same type holding fakes. To test one action, add one node of it to a fresh `Graph` and `execute` it against `createMemoryDagFs()` (seeded with any input files), a `MemCache` and fake ports, then read the result's `outputs` back through the memory filesystem's `.files`. The worked example on [dagraph-graphs](dagraph-graphs.md) runs this way. `processNode(graph, name, {}, context, { acquire: ungated })` does the same for one node without an orchestrator.

A test of one action in that form (verified: it passes under `bun test` with Bun 1.4.4, and type-checks under the repository's `tsconfig.json` with both TypeScript 6.0.3 and `tsgo`):

```ts
import { expect, test } from "bun:test";
import {
  actionsFor,
  createMemoryDagFs,
  execute,
  file,
  Graph,
  MemCache,
  nodeInputs,
  soleOutput,
  type DagFs,
  type FileInput,
} from "@mrmeku/dagraph";

interface Ports {
  fs: DagFs;
  translator: { translate(text: string, language: string): Promise<string> };
}
const defineActionWithPorts = actionsFor<Ports>();

const translate = defineActionWithPorts({
  kind: "translate",
  inputs: { version: 1 },
  nodeInputs: nodeInputs<{ page: FileInput; language: string }>,
  action: async ({ inputs, outputDir, ports }) => {
    const text = await ports.translator.translate(await inputs.page.text(), inputs.language);
    const out = `${outputDir}/page.${inputs.language}.txt`;
    await ports.fs.writeText(out, text);
    return out;
  },
});

test("translate writes the page in the language it is given", async () => {
  const fs = createMemoryDagFs({ "/page.txt": "hello" });
  const translator = {
    translate: async (text: string, language: string) => `${language}: ${text}`,
  };
  const graph = new Graph<Ports>();
  translate.addNode(graph, { inputs: { page: file("/page.txt"), language: "fr" } });

  const [result] = await execute(graph, {
    ports: { fs, translator },
    fs,
    cache: new MemCache(),
    casBaseDir: "/cas",
  });

  if (result?.status !== "done") throw new Error(JSON.stringify(result));
  expect(fs.files.get(soleOutput(result.outputs))).toBe("fr: hello");
});
```

What it relies on:

- The action writes through its `fs` port, and the test passes the same memory file system as the port and as the context's `fs`, so the engine finds, hashes and moves what the action wrote. An action that writes with `node:fs` directly cannot run against the memory file system: its `ensureDir` does nothing, so the output directory does not exist on disk, the write fails, and the node settles `failed` with `ENOENT: no such file or directory, open '/cas/<key>/tmp-<uuid>/<file>'` (checked by a separate run).
- After the execution, `.files` holds the seeded `/page.txt` and the one published output, `/cas/<actionKey>/out-<contentHash>/page.fr.txt`, and nothing else: a `MemCache` keeps its entries in memory, not in the file system.
- `soleOutput` picks the one path out of `outputs`, and `namedOutput(outputs, name)` picks one out of a record ([dagraph-graphs](dagraph-graphs.md)). Both need the result narrowed to a success first, which the `if` does. On any other status it fails the test with the whole result as its message: a translator that throws `quota exceeded` gives `{"name":"translate","actionKey":"<64 hex>","status":"failed","error":{"name":"Error","message":"quota exceeded"},"elapsed":<ms>}`, and the file system then holds only `/page.txt`.
- `await processNode(graph, "translate", {}, context, { acquire: ungated })` in place of `execute` returns the same `done` result, with the same key and outputs (checked by a separate run).

### Worked example

Two actions: `fetch` writes a page, `summarize` reads it. The second execution finds both nodes in the cache.

```ts
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAction, execute, FsCache, Graph, nodeInputs, tally } from "@mrmeku/dagraph";
import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";

const fetchPage = defineAction({
  kind: "fetch",
  nodeInputs: nodeInputs<{ url: string }>,
  action: async ({ inputs, outputDir }) => {
    const path = join(outputDir, "page.txt");
    await writeFile(path, `page ${inputs.url}`);
    return path;
  },
});
const summarize = defineAction({
  kind: "summarize",
  deps: { page: fetchPage },
  action: async ({ depOutputs, outputDir, output }) => {
    const text = await depOutputs.page.text();
    output(`summarizing ${text.length} chars\n`);
    const path = join(outputDir, "summary.txt");
    await writeFile(path, text.toUpperCase());
    return path;
  },
});

const casBaseDir = join(await mkdtemp(join(tmpdir(), "dag-")), "cas");
const fs = createNodeDagFs();
const context = { cache: new FsCache(casBaseDir, fs), fs, casBaseDir };
const graph = new Graph();
const page = fetchPage.addNode(graph, { name: "fetch", inputs: { url: "https://example.com" } });
summarize.addNode(graph, { name: "summarize", deps: { page } });

console.log(tally(await execute(graph, context)));
console.log(tally(await execute(graph, context)));
```

It prints (verified with Bun):

```
{ done: 2, cached: 0, failed: 0, "dep-failed": 0, cancelled: 0 }
{ done: 0, cached: 2, failed: 0, "dep-failed": 0, cancelled: 0 }
```

With `onEvent: (e) => console.log(e.type, e.node)` and `scheduler: throttledScheduler({ maxParallelism: 1 })` on the first execution, the events are `dispatch fetch`, `start fetch`, `result fetch`, `dispatch summarize`, `start summarize`, `output summarize`, `result summarize`. On the second execution the nodes only get `dispatch` and `result`, since a hit never starts.

Where it lives: `packages/dagraph/src/execute.ts`, `process-node.ts` (`ExecutionContext`), `ports/memory-fs.ts`.

## The life of a node

A node moves through these states. Each arrow names what moves it.

1. **Waiting**: some dep has not settled. A node with no deps skips this state.
2. **Ready**: every dep has settled, whatever its status. The node waits for the scheduler to admit it.
3. **Admitted**. Orchestration first checks the node's _required_ deps (every dep but those marked `settled`). If one did not succeed, the node settles `dep-failed` at once, with no dispatch event and no action key. Otherwise orchestration emits `dispatch` and hands the node to processing.
4. **Looking up**. Processing computes the action key. If that fails (an input file cannot be read, an `invalidateOn` fingerprint throws or returns no string), the node settles `failed`, with no action key. Unless `force` is set or the node is not cacheable, it reads the cache. A verified entry settles the node `cached`. A cache whose read rejects counts as a miss, never as a failure.
5. **Waiting for its slot**: only a miss whose action is in a concurrency group. It gives its place back and waits until the scheduler grants it a slot.
6. **Starting**: the engine makes a fresh, empty output directory for this attempt and emits `start`. If the listener returns a promise, the action waits for it.
7. **Running**: the action runs with a signal that fires on the node's timeout or on the execution's cancel.
8. **Settled**: `done` (outputs stored, entry written unless the node is not cacheable), `failed`, or `cancelled`.

A node that does not succeed never gets a cache entry, so its next execution starts it again. If it fails or is cancelled before its outputs are published, its attempt's directory is removed (best effort: a failed removal changes nothing in the result). The one case that leaves files behind is a cache write that rejects. By then the outputs are already published under `<casBaseDir>/<actionKey>/out-<contentHash>/`, so the node settles `failed` but that directory stays, with no entry pointing at it.

Where it lives: `packages/dagraph/src/orchestrate.ts`, `process-node.ts`, `exec-state.ts`.

## Results

A `Result` is how one node settled. It always has `name` (the node's name) and `actionKey` (the node's key, or `""` when it never got one). The rest depends on `status`:

| `status`     | Extra fields                                  | When                                                                                                                                                                          |
| ------------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `done`       | `outputs`, `contentHash`, `elapsed`           | The action ran and its outputs were stored.                                                                                                                                   |
| `cached`     | `outputs`, `contentHash`                      | A verified cache entry was found. No `elapsed`.                                                                                                                               |
| `failed`     | `error: { name, message, cause? }`, `elapsed` | The node could not be keyed, or its action threw, timed out, or returned paths that are outside its output directory or cannot be read, or the work around the action failed. |
| `dep-failed` | `dep`                                         | A required dep did not succeed. `dep` names it.                                                                                                                               |
| `cancelled`  | none                                          | The execution was cancelled before or while the node ran.                                                                                                                     |

`outputs` and `contentHash` together are the node's cache entry (`CacheEntry`, from [dagraph-caching](dagraph-caching.md)): `outputs` is the path, list of paths or record of either that the action returned, moved to where the CAS keeps them. `elapsed` is in milliseconds, counted from the action's start to the result, so it includes hashing and storing the outputs. It is `0` for a failure that happened before the action started.

The engine does not check the shape of what an action returns. The types require `Outputs`: a path, a list of paths, or a record of either. A value cast past the types fails with an unhelpful `TypeError` (`undefined`, `null`, or a list or record holding a non-string), and a number or boolean even settles `done` with `outputs: {}` and is cached.

When `actionKey` is empty: a `dep-failed` node, a node cancelled before it was dispatched, a node whose key could not be computed, and a node whose `RunNode` rejected. A node that was looked up or ran keeps its key, even when it then failed or was cancelled.

### A result is plain data

A result holds only JSON, so it can be written to a file or sent to another process as it is. The engine builds a failure's `error` from what was thrown, and keeps only its name, message and cause: the stack and any other own property (`code`, `exitCode`, `stderr`, …) are dropped, so whatever a caller needs to see must go in `cause`.

- `name` is the thrown error's name, or `"Error"` when the thrown value is not an `Error`.
- `message` is the error's message, or the thrown value turned into a string (`throw "boom"` gives `{ name: "Error", message: "boom" }`).
- `cause` is the thrown error's own `cause`, converted to JSON. A JSON cause is copied, so changing it afterwards does not change the result; an `undefined` property is dropped and `-0` becomes `0`. An `Error` cause becomes `{ name, message, cause? }`, with its own cause converted the same way, and the chain stops at an error that comes again. Anything else is dropped, and so is the whole cause: a cycle, `NaN`, `Infinity`, a `bigint`, a `Map` or other class instance, an array holding an `undefined` item or a hole, or a cause whose getter throws.

For example, `throw new RangeError("bad exited 1", { cause: { argv: ["bad"], code: 1 } })` gives `{ name: "RangeError", message: "bad exited 1", cause: { argv: ["bad"], code: 1 } }`.

A cached result, as JSON:

```json
{
  "name": "fetch-b",
  "actionKey": "42a8d5ee…43756",
  "status": "cached",
  "outputs": "<casBaseDir>/42a8d5ee…43756/out-c844d585…44b6/page.txt",
  "contentHash": "c844d585…44b6"
}
```

### Helpers

- `isResult(value)` tells whether a value read back from a file or another process is a `Result`. It checks the fields each status needs: `done` needs `elapsed` and an entry, `cached` an entry, `failed` an `elapsed` and an `error` whose `name` and `message` are strings and whose `cause`, if any, is JSON, `dep-failed` a `dep`. Every result needs `name` and `actionKey` as strings. An unknown status is refused.
- `isSucceeded(result)` is true for `done` and `cached`, and narrows the result to `SucceededResult`, which carries `outputs` and `contentHash`.
- `FailedError` is the type of a failed result's `error`.
- `tally(results)` counts results by status. It returns a `Tally`, a record with all five statuses as keys, zero when none: `{ done, cached, failed, "dep-failed", cancelled }`.

Where it lives: `packages/dagraph/src/types.ts`, `utils.ts`.

## Failure semantics

**A failure holds back only what needs it.** When a node fails, every node that requires it settles `dep-failed`, and so does every node that requires those, transitively. Nodes on other branches carry on. There is no fail-fast mode. For example, with `top → left, right → bottom` where `left` fails: `top` and `right` are `done`, `left` is `failed`, and `bottom` is `dep-failed` with `dep: "left"`. Further down a chain, `dep` names the direct dep: in `bad_root → mid → leaf`, `mid` has `dep: "bad_root"` and `leaf` has `dep: "mid"`.

When a node has several deps that did not succeed, `dep` names the first of them in the node's dep order (the order its roles were given).

**A `settled` dep never holds its node back.** A dep declared with `settled(...)` (see [dagraph-graphs](dagraph-graphs.md)) is waited for, not required: when it does not succeed, its dependent runs without it and its role reads `undefined`. A node that names the same dep in two roles, one plain and one `settled`, still requires it.

**Failures are never cached.** The next execution tries the failed node again, and nodes that were held back with it. An interrupted execution resumes where it stopped: with `a → b → c → d` where `b` fails once, the first execution gives `a: done, b: failed, c: dep-failed, d: dep-failed`; the second gives `a: cached` and starts only `b`, `c` and `d`.

**What fails a node, and the message a caller sees:**

| Cause                                                                                                   | `error`                                                                                                                         | Key? |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---- |
| The action throws                                                                                       | its name, message and cause                                                                                                     | yes  |
| The node's timeout fires                                                                                | `name: "TimeoutError"`, `message: "timed out after <timeoutMs> ms"`, the thrown error's `cause`                                 | yes  |
| An input file cannot be read, or a fingerprint throws                                                   | that error                                                                                                                      | no   |
| A fingerprint returns no string                                                                         | `invalidateOn.<role> returned <type>, not a string. JSON.stringify returns undefined for undefined: give it the value ?? null.` | no   |
| A returned path lies outside the output directory                                                       | `output not under the output dir: <path> is not under <outputDir>`                                                              | yes  |
| A returned path has no file, or cannot be read                                                          | named by [dagraph-caching](dagraph-caching.md)                                                                                  | yes  |
| The `start` listener throws or rejects                                                                  | that error, `elapsed: 0`, the action never runs                                                                                 | yes  |
| The output directory cannot be made, or the cache write fails (the published outputs then stay on disk) | that error                                                                                                                      | yes  |
| A `cacheOnly` lookup misses                                                                             | `{ name: "Error", message: "not cached" }`, `elapsed: 0`                                                                        | yes  |
| The `RunNode` rejects                                                                                   | its error, `elapsed: 0` (or `cancelled` once the execution is cancelled)                                                        | no   |

Where it lives: `packages/dagraph/src/orchestrate.ts`, `exec-state.ts`, `process-node.ts`.

## The order of ready nodes

Orchestration keeps the ready nodes in one ordered list. A scheduler takes from it in that order; it may hold a node back, but it never reorders the list. The order aims to finish one branch before starting the next, so partial work is useful early (for example, one item fully processed rather than every item half done).

The rule:

1. Each node has a **root priority**: the position, in the order the nodes were added, of the earliest-added root (node with no deps) it descends from. A lower number goes first.
2. Among nodes of equal priority, the one that became ready **most recently** goes first. Nodes that became ready together keep the order they were added in.
3. A miss that waits for its group's slot goes back into the list at its own priority, under the same rule.

Worked example. Nodes are added in this order: `r1`, `r2`, `c1` (needs `r1`), `c2` (needs `r1`), `g1` (needs `c1`), `both` (needs `r2` and `c2`). Priorities: `r1`, `c1`, `c2`, `g1` and `both` have 0 (they descend from `r1`), `r2` has 1. With `throttledScheduler({ maxParallelism: 1 })` the nodes start in this order:

```
r1 c1 g1 c2 r2 both
```

`r1` and `r2` are ready first; `r1` wins on priority. When `r1` settles, `c1` and `c2` become ready together, both at priority 0, ahead of `r2`. When `c1` settles, `g1` becomes ready, and as the most recent at priority 0 it goes ahead of `c2`. `both` has priority 0 but is not ready until `r2` settles, so it comes last.

With the default scheduler, everything ready is admitted at once, so the order only decides which lookups and actions begin first. It matters under a limit.

Where it lives: `packages/dagraph/src/exec-state.ts`.

## Schedulers

A **scheduler** is the policy that admits ready nodes. It is a function that orchestration calls once per execution with a `SchedulerContext`, and it resolves when there is no work left. Two are built in.

### `unboundedScheduler()`

Admits every ready node at once. It is the default of `execute`. Concurrency groups still work under it, but with no limit, a miss is granted its slot as soon as it asks.

### `throttledScheduler(options?)`

A global limit and one limit per concurrency group, like Ninja's `-j` and its pools.

| Option              | Default    | Meaning                                                                                                      |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `maxParallelism`    | `Infinity` | The most nodes processed at once: looking up or running. A miss waiting for its group's slot does not count. |
| `concurrencyLimits` | `{}`       | For each group name, the most of its actions that run at once. A group with no entry has no limit.           |

Each limit must be a whole number from 1, or `Infinity`. Otherwise `throttledScheduler` throws a `RangeError` when it is called, naming the field: `throttledScheduler: maxParallelism must be a whole number from 1, or Infinity, got 0`, or `throttledScheduler: concurrencyLimits.heavy must be a whole number from 1, or Infinity, got 1.5`. With neither option given, `throttledScheduler()` behaves as `unboundedScheduler()`.

A node's group comes from its action's `concurrencyGroup` field. Setting it requires binding the group names when the actions are defined: `actionsFor<Ports, "network" | "heavy">()`, or, from the limits themselves, `const limits = { network: 5, heavy: 1 }` and `actionsFor<Ports, keyof typeof limits>()` (`actionsFor` is [dagraph-graphs](dagraph-graphs.md)'s). Actions with no ports bind `actionsFor<unknown, keyof typeof limits>()`, since `defineAction` is `actionsFor<unknown>()`; `actionsFor<{}, …>()` does not fit a plain `new Graph()` and forces `ports: {}` into the context. The same plain object type-checks passed directly as `throttledScheduler({ concurrencyLimits: limits })`. As everywhere, the action must return its outputs: one that returns nothing does not type-check. Plain `defineAction` and `actionsFor<Ports>()` take no group at all, since their group type defaults to `never`. So binding is the only way to set a group, and a misspelt group does not compile.

A group name must be non-empty. A node with `concurrencyGroup: ""` still gives up its place and asks for a slot, but `throttledScheduler` treats it as ungrouped, so `concurrencyLimits[""]` is silently ignored (checked by a separate run: three such nodes under `{ concurrencyLimits: { "": 1 } }` ran three at once).

**Places and slots.** A node takes a _place_ (one unit of `maxParallelism`) when it is dispatched, and holds it until it settles. A hit holds it only for its lookup. A miss outside any group keeps its place straight through to its start. A miss in a group gives its place back while it waits for the group's _slot_, and then waits until a place and a slot are both free, and takes both. So:

- A hit never takes a slot, and never waits for one.
- A miss waiting for its slot never blocks other work: its place goes to the next ready node.
- Misses waiting for one group's slot get it in the ready order (root priority), not in the order they asked.

Worked example, from the tests: `throttledScheduler({ maxParallelism: 2, concurrencyLimits: { heavy: 1 } })` over four nodes, `holder` (heavy, a miss), `waiter` (heavy, a miss), `hit` (heavy, in the cache) and `free` (no group, a miss). The log reads:

```
dispatch holder
dispatch waiter       two places used
granted holder        holder and waiter each gave their place back; holder gets the heavy slot
dispatch hit
cached hit            a hit, so no slot needed
dispatch free
granted free          places: holder, free
done holder
granted waiter        the heavy slot is free again
```

Another: with `{ concurrencyLimits: { heavy: 1 } }` and three roots `root_a`, `root_b`, `root_c` (added in that order), each with a heavy child: when `root_c` finishes first, `heavy_c` gets the slot. Then `root_b` and `root_a` finish, and `heavy_b` asks before `heavy_a`. When `heavy_c` finishes, the slot goes to `heavy_a`, since `root_a` was added first.

A scheduler returned by `throttledScheduler` keeps its counts across calls: they belong to the `throttledScheduler(...)` call, not to one execution. Using it for one execution after another is fine. Shared by executions that run at the same time, it hangs the whole process or one of the executions, and whether that makes sharing a misuse or the hang a bug is not settled (see "Open questions"). Until it is, give each execution that may overlap another a `throttledScheduler(...)` of its own, as every caller in this repository does. Nothing built in then gives one limit across those executions.

Where it lives: `packages/dagraph/src/schedulers.ts`, `orchestrate.ts`.

## Writing your own scheduler

A `Scheduler` is `async (ctx) => void`, generic in the graph's meta type. The `SchedulerContext` gives it four functions:

- `take(filter?)` removes and returns the first ready entry, in the ready order, that `filter` admits, or `null`. An entry is a `Ready`: `{ node, acquiring }`. `node` is the node as data (`name`, `kind`, `meta`, `deps`, `settledDeps`, `concurrencyGroup`, `cacheable`, `timeoutMs`). `acquiring` is `false` the first time a node comes, when it is ready to be processed, and `true` when it comes again as a miss asking for its group's slot.
- `run(ready)` hands a ready node to processing, or grants an acquiring one its slot. It resolves once the node settles or, for a miss that goes to wait for its slot, once it gives its place back.
- `hasWork()` is true while some node is ready or being processed.
- `workAvailable()` resolves when what `take` returns may have changed: a node settled, a miss asked for its slot, or the execution was cancelled. It resolves at once when nothing is being processed.

The rules a scheduler must keep:

- Take nodes in the order `take` gives them. A scheduler only filters; it cannot reorder.
- Keep going until `hasWork()` is false. Orchestration's result is read when the scheduler resolves.
- Eventually run every entry, the acquiring ones included. A miss waits for its slot until its acquiring entry is run.
- If it holds nodes back by a count, try again whenever a `run` resolves, not only when `workAvailable` resolves. `workAvailable` can resolve before the code after a `run` has updated the count.
- Call `workAvailable` from one loop only: it wakes one waiter.
- Once cancelled, `take` settles the remaining ready nodes `cancelled` itself and returns `null`, so a scheduler needs no cancel logic of its own.

The simplest scheduler runs one node at a time:

```ts
import type { Scheduler } from "@mrmeku/dagraph";

const serial: Scheduler = async (ctx) => {
  while (ctx.hasWork()) {
    const next = ctx.take();
    if (next) await ctx.run(next);
    else await ctx.workAvailable();
  }
};
```

Over `r1`, `r2` and `c1` (needs `r1`), it starts `r1 c1 r2`.

One that runs at most one node of each kind at a time, in the same shape as the built-in schedulers (verified: with three `encode` and three `upload` nodes, at most one of each ran at once):

```ts
import type { Ready, Scheduler } from "@mrmeku/dagraph";

const onePerKind: Scheduler = async (ctx) => {
  const running = new Set<string>();
  const admits = ({ node }: Ready) => !running.has(node.kind);
  const dispatch = () => {
    let next: Ready | null;
    while ((next = ctx.take(admits))) {
      const { kind } = next.node;
      running.add(kind);
      void ctx.run(next).then(() => {
        running.delete(kind);
        dispatch();
      });
    }
  };
  while (ctx.hasWork()) {
    dispatch();
    await ctx.workAvailable();
  }
};
```

This one counts entries, not nodes: a miss in a concurrency group gives its place back, frees its kind, and comes back as an acquiring entry. So it holds only for actions without a group.

Where it lives: `packages/dagraph/src/orchestrate.ts` (`SchedulerContext`), `schedulers.ts`.

## Events and listeners

An execution reports what happens as one stream of `ExecEvent`s. Each event has `type`, `node` (the node's name) and, when the node has one, `meta` (the node's metadata, from [dagraph-graphs](dagraph-graphs.md)). `ExecEvent` is a union that narrows on `type`: a listener reads `event.chunk` after checking `event.type === "output"` and `event.result` after `event.type === "result"`. The types:

| `type`     | Extra            | Emitted by    | When                                                  |
| ---------- | ---------------- | ------------- | ----------------------------------------------------- |
| `dispatch` | none             | orchestration | The node is handed to processing.                     |
| `start`    | none             | processing    | On a miss, as the action is about to run.             |
| `output`   | `chunk` (string) | processing    | The action called `output(chunk)` to print something. |
| `result`   | `result`         | orchestration | The node settled.                                     |

The events of one node come in the order `dispatch`, `start`, `output`…, `result`. Events of different nodes interleave, and each is emitted as it happens, so a listener sees a `start` while other nodes still run. What each kind of node gets:

- A node that runs: `dispatch`, `start`, any `output`s, `result`.
- A cached node: `dispatch`, `result`.
- A `dep-failed` node, or one cancelled before it was dispatched: `result` only.
- What an action prints after its result came back is dropped: no `output` event follows `result`.

An `ExecListener` is `(event) => unknown`. What it returns matters only for some events:

- **`start`**: if it returns a promise, the action runs only once that promise resolves. This lets a journal record the start before the action has any effect: `onEvent: (event) => journal.record(event)`. If the listener throws or the promise rejects, the node fails with that error and its action never runs.
- **`output`**: a returned promise is not awaited, and its rejection is dropped.
- **`dispatch` and `result`**: a throw, or a returned promise that rejects before the execution ends, stops nothing. Every node still settles; then `execute` (or `orchestrate`) rejects with the first such error, and its results are not returned. The listener error is checked once, after the scheduler returns, so a promise that rejects after the execution ends is dropped silently and the execution resolves normally.

`ExecEvent` and `ExecListener` default `Meta` to `unknown` (`Graph`'s own `Meta` defaults to `undefined`). So a plain `const onEvent: ExecListener = (event) => console.log(event.type, event.node)` type-checks, and can be passed to `execute`, `orchestrate` and `processNode` for a graph with any `Meta`, `new Graph<unknown, { team: string }>()` included (checked with tsc).

In `execute`, the one `onEvent` gets all four types. With `orchestrate` and `processNode` used apart, `orchestrate`'s `onEvent` gets `dispatch` and `result`, and `processNode`'s gets `start` and `output`.

Where it lives: `packages/dagraph/src/types.ts` (`ExecEvent`, `ExecListener`), `orchestrate.ts`, `process-node.ts`.

## Timeouts

An action may declare `timeoutMs`: how long it may run, in milliseconds. It must be a whole number from 1 to 2147483647 (the longest delay `setTimeout` honors); otherwise `defineAction` throws `RangeError: action "<kind>": timeoutMs must be a whole number of ms from 1 to 2147483647, got <value>`. The node data carries it as `timeoutMs`.

- The clock starts when the action starts: after the cache lookup, the slot wait, the output directory and the `start` event.
- When it runs out, the action's `signal` aborts with a `DOMException` named `"TimeoutError"` (message `"The operation timed out."`).
- The node then fails **whatever the action does next**, even if it returns outputs: `error.name` is `"TimeoutError"`, `error.message` is `"timed out after <timeoutMs> ms"`, and `error.cause` is the cause of the error the action threw as it stopped, if any. The result is never cached, so the next execution runs the node again.
- The timeout is cooperative. The engine does not abandon the action: it waits for the action to settle. An action that ignores its signal runs to its end. No test pins this; a separate run checked it: a 10 ms timeout on an action that ignores its signal and sleeps 200 ms gives `failed` with `TimeoutError` and `elapsed` of about 200. How an action stops on time is under "Honouring the signal".
- `timeoutMs` is not part of the action key. Changing it re-keys nothing.

Where it lives: `packages/dagraph/src/process-node.ts`, `define-action.ts`.

## Cancellation

Pass `signal` to cancel an execution, typically from an `AbortController` aborted on Ctrl-C. Once it aborts:

- **Nothing new starts.** Every node that is ready, or becomes ready, settles `cancelled` without being dispatched (empty `actionKey`, `result` event only). The dependents of a cancelled node settle `cancelled` too, not `dep-failed`.
- **A miss waiting for its group's slot** stops waiting and settles `cancelled`. It keeps its action key, since it was looked up.
- **A running node** sees the cancel through its action's `signal`, whose `reason` is the signal's reason (for example the error passed to `controller.abort(reason)`). Whatever the action then returns, the node settles `cancelled`, its attempt's directory is removed, and nothing is cached. This matches GitHub's runner: once the signal fired, the action's exit no longer decides.
- **A cancel wins over a timeout.** If the timeout fired first and the cancel lands before the action settles, the node is `cancelled`.
- **A cancel during the steps before the action**, while the output directory is made or while the `start` listener's promise is pending, holds the action back: the node settles `cancelled` and its action never runs, even though a journal may already have recorded its start.
- **A lookup that hits** is still `cached`; a cancel does not undo a hit. A cancel that lands after the action returned, while its outputs are stored, does not undo `done`.
- **The results are complete.** `execute` still resolves with one result per node. A signal that is already aborted when `execute` is called gives every node `cancelled` with no `dispatch` and no `start`.

Like a timeout, a cancel is cooperative: the execution ends only once each running action settles (see "Honouring the signal").

**A timeout for the whole execution** is a cancel on a timer: `execute(graph, context, { signal: AbortSignal.timeout(60_000) })`. When it fires, the nodes behave as on any cancel. Verified: with a node `a` that waits on its signal and a dependent `later`, `{ signal: AbortSignal.timeout(50) }` gives `a: cancelled` (with its action key, since it was looked up) and `later: cancelled` (empty key), tally `{ done: 0, cached: 0, failed: 0, "dep-failed": 0, cancelled: 2 }`. To have both Ctrl-C and a deadline, combine them with `AbortSignal.any([controller.signal, AbortSignal.timeout(ms)])`. A per-node limit is the action's `timeoutMs` instead, which fails the node rather than cancelling it.

An execution removes every listener it added to `signal` when it ends, and each node's timeout timer is cleared once its action settles. So one long-lived `AbortSignal`, such as a process-wide Ctrl-C controller, can be passed to many executions in turn without piling up listeners.

A worked example from the tests: `slow` (in the first execution only, waits for its signal, then returns normally), `quick`, `after` (needs `quick`) and `never` (needs `slow`), under `maxParallelism: 2`, with the abort fired from the listener when `quick`'s result arrives. The events are `start:slow`, `start:quick`, `done:quick`, `cancelled:after`, `cancelled:slow`, `cancelled:never`, and the tally is `{ done: 1, cached: 0, failed: 0, "dep-failed": 0, cancelled: 3 }`. Only `quick` and `slow` have an action key. The test then makes `slow` stop waiting, since with no signal it would never resolve, and the next execution without a signal finds `quick` cached and runs the other three. The order `start:slow`, `start:quick` holds with `createMemoryDagFs()` and a `MemCache`, as in the test; with a real file system the two starts may come in either order.

Where it lives: `packages/dagraph/src/orchestrate.ts`, `process-node.ts`.

## Honouring the signal

A timeout and a cancel reach a running action the same way: its context's `signal`, a plain `AbortSignal`, aborts. Only the `reason` differs: a `DOMException` named `"TimeoutError"` on a timeout, the execution signal's reason on a cancel. Once it has fired, the engine decides the result whatever the action returns or throws, but it still waits for the action to settle. So honouring the signal means stopping soon and letting go of what the action started; the action has no status left to choose. The engine does no more than abort the signal: it stops no child process and interrupts no call.

The pattern:

- **Pass `signal` on** to every call that takes one: `fetch(url, { signal })`, `execFile` and `spawn` of `node:child_process` (`{ signal }`), `setTimeout(ms, value, { signal })` of `node:timers/promises`, `readFile(path, { signal })` of `node:fs/promises`, `pipeline(..., { signal })` of `node:stream/promises`. `fetch` rejects with the signal's reason itself; the others reject with an `AbortError` whose `cause` is the reason (checked under Bun 1.4.4 and Node 25.8.1, `fetch` against a local server that never answers).
- **Check it between steps** that take no signal: `signal.throwIfAborted()` throws the signal's reason, so a loop of short steps stops at the next one.
- **Give slow ports a `signal` parameter** and pass the action's own on. Ports are passed through untouched ([dagraph-graphs](dagraph-graphs.md)), so a port method that takes no signal cannot be stopped. dagworkflows' ports do this: `exec.run(argv, { signal })` and `clock.sleep(ms, signal)` ([dagworkflows-lifecycle](dagworkflows-lifecycle.md), "Cancellation and signals").
- **Stop a child process's whole tree.** A child given `signal` gets its `killSignal` (default `SIGTERM`) and nothing else gets anything, so whatever the child started keeps running after the node settled. To stop all of it, spawn the child `detached: true`, which on POSIX makes it the leader of a process group of its own, and on abort signal the group: `process.kill(-child.pid, "SIGTERM")`. dagworkflows' real `Exec` does this, sending SIGINT, then SIGTERM, then SIGKILL, as GitHub's runner does.
- **Say what was running in the error's `cause`.** A timed-out node keeps the cause of what its action threw as it stopped. An `AbortError` from a call that got the signal has the `TimeoutError` as its cause, so the result reads `cause: { name: "TimeoutError", message: "The operation timed out." }`. `throwIfAborted()` and `fetch` throw the `DOMException` itself, which has no cause, so the result has none. To show the command instead, throw an error whose `cause` names it, as `runTree` below does. A cancelled node has no `error` at all.

Verified under Bun 1.4.4 and Node 25.8.1, and type-checked under the repository's `tsconfig.json` with TypeScript 6.0.3 (with `types: ["node"]`):

```ts
import { execFile, spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defineAction, execute, FsCache, Graph } from "@mrmeku/dagraph";
import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";

// Runs argv in a process group of its own, and on abort stops the whole group.
function runTree(argv: string[], signal: AbortSignal) {
  const [bin = "", ...args] = argv;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    const stop = () => child.pid && process.kill(-child.pid, "SIGTERM");
    signal.addEventListener("abort", stop, { once: true });
    child.on("error", reject);
    child.on("close", (code, killedBy) => {
      signal.removeEventListener("abort", stop);
      if (code === 0) resolve();
      else
        reject(new Error(`${bin} exited ${code ?? killedBy}`, { cause: { argv, code, killedBy } }));
    });
  });
}

const passOn = defineAction({
  kind: "pass-on",
  timeoutMs: 100,
  action: async ({ outputDir, signal }) => {
    await promisify(execFile)("sleep", ["5"], { signal });
    await writeFile(join(outputDir, "out.txt"), "done");
    return join(outputDir, "out.txt");
  },
});
const steps = defineAction({
  kind: "steps",
  timeoutMs: 100,
  action: async ({ outputDir, signal }) => {
    for (let step = 0; step < 250; step++) {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return outputDir;
  },
});
const tree = defineAction({
  kind: "tree",
  timeoutMs: 100,
  action: async ({ outputDir, signal }) => {
    await runTree(["sh", "-c", "sleep 5; true"], signal);
    return outputDir;
  },
});

const casBaseDir = join(await mkdtemp(join(tmpdir(), "dag-")), "cas");
const fs = createNodeDagFs();
const graph = new Graph();
for (const action of [passOn, steps, tree]) action.addNode(graph, {});
for (const r of await execute(graph, { cache: new FsCache(casBaseDir, fs), fs, casBaseDir }))
  console.log(r.name, r.status, r.status === "failed" ? JSON.stringify(r.error) : "");
```

Under both runtimes it prints the three nodes in the order `pass-on`, `tree`, `steps`, each `failed` with `TimeoutError` and `timed out after 100 ms`, and no `sleep` is left running. Printed as well, `elapsed` is 102 to 110 ms, against the 5000 the work would take. The causes: `pass-on` has `{ name: "TimeoutError", message: "The operation timed out." }`, `tree` has `{ argv: ["sh", "-c", "sleep 5; true"], code: null, killedBy: "SIGTERM" }`, and `steps` has none. Under both, `promisify(execFile)("sh", ["-c", "sleep 5; true"], { signal })` in place of `runTree` settles just as soon, but leaves `sleep` running: `SIGTERM` reached only `sh` (checked by a separate run). On a cancel, an action like `pass-on` without a `timeoutMs` settles `cancelled` 100 ms after `controller.abort()` (checked by a separate run).

Where it lives: `packages/dagraph/src/process-node.ts` (`actionSignal`), `graph/types.ts` (`ActionContext`); `packages/dagworkflows/src/ports/real.ts` (`createExec`).

## `orchestrate`: the scheduling half

`orchestrate(nodes, run, scheduler, onEvent?, signal?)` does what `execute` does, except that it never processes a node itself: it calls `run` for that.

- `nodes`: the node data, any iterable of `Node`, usually `graph.describe()`. It carries no actions, inputs or fingerprints, so it can cross into another process when its `meta` can.
- `run`: a `RunNode`, `(node, depEntries, acquire) => Promise<Result>`. `depEntries` is the cache entry of each dep that succeeded, by dep name (a dep that did not succeed is absent). `acquire` is the node's slot gate (below).
- `scheduler`: required here; there is no default.
- `onEvent`: receives `dispatch` and `result`.
- `signal`: cancels, as in `execute`.

It resolves to one result per node, in settle order. It does no I/O, hashes nothing and never sees an action, so it runs inside a sandbox that allows no I/O, such as a Temporal workflow. For the same reason, the package index imports no I/O module; the file systems are on the `fs` subpaths.

`execute` is nothing more than `orchestrate` over `graph.describe()` with a `RunNode` that calls `processNode` on the same graph, passing `force`, `acquire`, `signal` and `onEvent` through. So an executor built from the two halves gets the same meaning for every primitive (keys, hits, `settled`, groups, timeouts, cancel, events) as `execute`: the halves are where those meanings live.

**Determinism.** `orchestrate` reads no clock, draws no random number and does no I/O. What it does depends only on the node data, the scheduler, the results its `RunNode` calls resolve to, and the order in which they resolve. A workflow engine that replays a recorded history (Temporal) reproduces those, so the orchestration replays the same way. The code makes no promise that the ready order or the calls stay the same across dagraph versions (see "Open questions").

**The built-in schedulers are deterministic too.** `unboundedScheduler()` and `throttledScheduler(...)` read no clock, draw no random number, set no timer and do no I/O: `schedulers.ts` imports only types, and its only state is the counts in the closure of a `throttledScheduler(...)` call. What they admit depends only on what `take`, `hasWork` and `workAvailable` return and on when each `run` resolves, so with either of them a Temporal workflow that runs `orchestrate` replays the same way. A scheduler of your own replays only if it keeps the same rule. No test or lint rule pins this; two separate runs checked it:

- Under Bun 1.4.4 and Node 25.8.1, with `Date`, `Math.random`, `performance.now`, every timer function, `queueMicrotask`, `process.nextTick` and `crypto`'s random functions wrapped to record each call, `orchestrate` over three roots, each with a `heavy` child and a plain one, called none of them under either scheduler, `throttledScheduler({ maxParallelism: 2, concurrencyLimits: { heavy: 1 } })` included, and made the same sequence of `run` calls twice.
- Under `@temporalio/worker` 1.24.0 on Node 25.8.1, `Worker.runReplayHistory` replayed hand-built histories of a workflow that takes `graph.describe()` as its argument and runs `orchestrate` over `r1`, `r2` and `c1` (needs `r1`), with one activity per node whose `activityId` is the node's name. A history in the order the scheduler gives replayed without error, twice: `r1 c1 r2` under `throttledScheduler({ maxParallelism: 1 })`, and `r1` and `r2` in one workflow task, then `c1`, under `unboundedScheduler()`. A history in another order failed with `DeterminismViolationError`, for example `Activity id of scheduled event 'r2' does not match activity id of activity command 'c1'`. Temporal compares activity IDs only when the history's first `WorkflowTaskCompleted` records core flag 1 (`sdkMetadata.coreUsedFlags: [1]`); without it the misordered histories replayed without error too.

**Node data into a Temporal workflow.** `graph.describe()` can go into a workflow as its argument (`args` of `client.workflow.start`) as well as an activity's result. Both pass through the same data converter, whose default writes a value as JSON (`json/plain`), and node data survives JSON whenever its `meta` does ([dagraph-graphs](dagraph-graphs.md), "`describe()`"). Either way the graph is built outside the sandbox: in the client that starts the workflow, or in an activity. Verified: through `defaultPayloadConverter` of `@temporalio/common` 1.24.0, the node data of a graph with meta (`null` included), a `settled` dep, `cacheable: false` and a `timeoutMs` comes back deep-equal, and `orchestrate` over the copy gives the same results; the replays above pass it as the workflow's first argument. A `bigint` in meta makes the converter throw `ValueError: Unable to convert [object Object] to payload`. On Temporal Cloud each workflow argument and each activity result is one payload, limited to 2 MB (`docs.temporal.io/cloud/limits`, read on 2026-10-26), so the node data of a large graph must fit in that either way.

Inside a Temporal workflow, `orchestrate` and the scheduler are workflow code: the dagraph bundled into the workers decides in which order the `RunNode` schedules its activities. So an integrator treats a dagraph upgrade, a patch release included, as a change to its workflow code, which Temporal requires to stay deterministic for every open workflow. A replay that meets another order of commands fails with `DeterminismViolationError`. What follows from Temporal's own docs (read on 2026-10-26: `docs.temporal.io/develop/typescript/versioning`, `docs.temporal.io/develop/typescript/testing-suite`, `docs.temporal.io/worker-versioning`; not run here, since it needs recorded histories):

1. **Pin dagraph to one exact version** in the project that bundles the workflows, with no range, so that no install changes it under open histories. `@mrmeku/dagworkflows` pins its `@mrmeku/dagraph` to its own version ([dagworkflows-cli-action-release](dagworkflows-cli-action-release.md)), which does nothing for a project that depends on dagraph directly.
2. **Replay before upgrading.** Download the histories of a representative set of recent open and closed workflows (`client.workflow.getHandle(id).fetchHistory()`, or the Temporal CLI), replay them under the new version with `Worker.runReplayHistories` (or `Worker.runReplayHistory` for one) from `@temporalio/worker`, and fail CI on any error. Temporal recommends this as a CI check for every change to workflow code.
3. **If a replay fails, or none was run, do not upgrade the workers in place** while workflows started under the old version are open. Either wait until none is open, or ship the upgrade under Worker Versioning with those workflows Pinned: a pinned workflow completes on the Worker Deployment Version it started on. Keep the old version's workers running while that version is Draining, that is until its pinned workflows have closed.

It refuses node data in which a node depends on a node it was not given, before anything runs, with the error `orchestrate: nodes depend on nodes it was not given: "a" needs "x"; "c" needs "y", "z"`.

**The `RunNode` contract.**

- It must resolve to the node's `Result`. Orchestration stores the dep entries of the nodes that succeed and holds back the dependents of those that did not, from the status alone. A `RunNode` may return a result recorded earlier instead of processing the node, as a replay does.
- If it rejects, the node settles `failed` with the rejection's name, message and JSON cause, `elapsed: 0` and an empty `actionKey`; or `cancelled`, once the execution is cancelled.
- `acquire()` is the gate a miss awaits before its action runs. For a node with no concurrency group it resolves at once. For a grouped node it returns the miss's place to the scheduler and resolves once the scheduler grants the slot. It rejects once the execution is cancelled (at once if the cancel came first). Calling it twice returns the same promise. A `RunNode` that never calls it, such as one that only found a hit, never takes a slot.

Where it lives: `packages/dagraph/src/orchestrate.ts`.

## `processNode`: the processing half

`processNode(graph, name, depEntries, executionContext, options)` processes the one node called `name`: it computes its key, reads and verifies its entry, and on a miss runs its action. It resolves to the node's `Result`.

- `graph` must hold the node, but it need not be the graph the orchestrator walks. Any graph that declares the node the same way gives it the same key, since a key depends only on the node's own kind, inputs and deps: the whole graph, a `closure` of it, or a graph rebuilt in a worker. If `graph` holds no node `name`, `processNode` rejects (it does not return a result) with: `processNode: the graph holds no node "<name>". Pass a graph that holds it: the whole graph, a closure of it, or any graph that declares the node the same way. A key is local to its node, so each gives it the same key.`
- `depEntries`: the entry of each dep that succeeded, by dep name, as `RunNode` receives it. If a required dep is missing from it, `processNode` returns `dep-failed` naming it.
- `executionContext`: as for `execute`.

The options:

| Option      | Default  | Effect                                                                                                                                                                                                            |
| ----------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acquire`   | required | The slot gate: `RunNode`'s `acquire`, or `ungated` outside an orchestrator. A rejection settles the node `cancelled`.                                                                                             |
| `force`     | `false`  | Skip the cache read: run the node, then write its new entry.                                                                                                                                                      |
| `cacheOnly` | `false`  | Look up without running. With no verified entry, the node fails with `NOT_CACHED` (`"not cached"`) as its message. With `force`, or for a node that is not cacheable, there is no lookup, so it fails so at once. |
| `signal`    | none     | The execution's cancel.                                                                                                                                                                                           |
| `onEvent`   | none     | Receives the node's `start` and `output` events before the result returns.                                                                                                                                        |

`ungated` is a gate that resolves at once, for `processNode` in a test, a script, or a worker whose orchestrator already took the node's slot.

### Forcing some nodes

`execute`'s `force` applies to every node. To force only some, write the executor yourself (verified):

```ts
import { orchestrate, processNode, throttledScheduler } from "@mrmeku/dagraph";

const forced = new Set(["encode-2"]);
const results = await orchestrate(
  graph.describe(),
  (node, depEntries, acquire) =>
    processNode(graph, node.name, depEntries, context, { acquire, force: forced.has(node.name) }),
  throttledScheduler({ maxParallelism: 4 }),
);
// encode-2 is done; every other node is cached.
```

### Processing nodes in another process

The split lets the orchestrator run in one place and the work in another. The pattern:

1. The orchestrator gets the node data (`graph.describe()`) and calls `orchestrate` with a `RunNode` that sends a request to a worker: the node's name, its `depEntries`, and whatever the worker needs to rebuild the graph.
2. To keep hits off the group's limit, the `RunNode` first asks a worker for a lookup only (`cacheOnly: true`). A result whose error message is `NOT_CACHED` means a miss; any other result is the node's.
3. On a miss, the `RunNode` awaits `acquire()` in the orchestrator, then sends the node to a worker to run.
4. The worker rebuilds a graph that declares the node, and calls `processNode` with `acquire: ungated`, since the orchestrator already holds the slot. It sends the `Result` back as JSON; the orchestrator can check it with `isResult`.

Workers and orchestrator must see the same CAS: `depEntries` and results hold paths into it (see [dagraph-caching](dagraph-caching.md) for how paths are stored). `processNode` looks entries up in the context's `cache`, which is separate from the CAS files, so for one worker to hit another's entries the workers also need one shared `Cache`, such as an `FsCache` over a shared directory. The orchestrator reads no files and needs neither. The `start` and `output` events happen in the worker; only `dispatch` and `result` reach the orchestrator's listener.

For a worker to compute the key the orchestrator's process would have, and to hit the entries other processes wrote:

1. **The same declaration.** The worker's graph must declare the node with the same `kind`, the same inputs (the action's own, including its `version`, and the node's) and the same roles. Names, meta, groups and timeouts may differ.
2. **The same files.** A `file()` input is keyed on its path as written and the bytes found there, read through the worker's own filesystem. A relative path is read from the worker's working directory.
3. **The same dep entries.** The worker keys on the content hashes in the `depEntries` it is given, and reads the dep files at the paths they hold.
4. **The same `casBaseDir` form.** Entries store paths relative or absolute as `casBaseDir` was. Processes that share one CAS but name it in different forms keep making each other miss: each rerun rewrites the entry in the rerunning process's form, so the other process misses on it next time. A relative `casBaseDir` that resolves to another directory is a different CAS altogether. A CAS restored under another working directory and read there with the same relative `casBaseDir` hits ([dagraph-caching](dagraph-caching.md)).

Results cross back as JSON with nothing lost (see "A result is plain data"), and `isResult` checks one read back. A replay passes a recorded result back from `RunNode` instead of calling a worker.

Where it lives: `packages/dagraph/src/process-node.ts`, `orchestrate.ts`.

## Rules that always hold

- Every node given gets exactly one result, also on cancel, unless the scheduler returns early (see below) or throws.
- A node is never processed before all its deps have settled.
- A node that did not succeed leaves no cache entry. It leaves no attempt directory either, unless the cache write itself failed after its outputs were published.
- `cancelled`, `failed` and `dep-failed` are never cached; the next execution retries them.
- A hit never starts, never emits `start`, and never takes a group slot.
- A scheduler only filters the ready order; it never reorders it.

## Open questions

1. **A synchronous throw from the listener on an `output` event fails the node.** The docs of `ExecListener` say only that an `output` promise's rejection is dropped. A listener that throws synchronously on `output` throws inside the action's `output(chunk)` call, so unless the action catches it, the node fails with the listener's error (verified: `{ name: "Error", message: "listener broke" }`). Intended?
2. **Sharing one `throttledScheduler` between executions that run at the same time: a rule or a bug?** The code does not say. Its counts (the places in use, and the slots in use per group) live in the closure of the `throttledScheduler(...)` call, so two executions running at once count each other's nodes, while each wakes only on its own events. Two failures follow. Verified under Bun 1.4.4 and Node 25.8.1, with two `orchestrate` calls of two nodes each, run at once over one scheduler, each node a 50 ms miss:
   - With `maxParallelism: 1`, the execution with nothing in progress spins on `workAvailable` (which resolves at once when nothing is being processed) and blocks the event loop: not even a 2 s watchdog timer fired, and the process stayed up until killed.
   - With only `concurrencyLimits: { heavy: 1 }` and grouped nodes, the event loop keeps running, but the second execution's misses never get the slot once the first execution frees it, because freeing it wakes only the first execution's loop. The first execution settles both its nodes; the second never resolves. Node then exits with code 13 and `Warning: Detected unsettled top-level await`; Bun stays up until killed.

   Reusing it for one execution after another works (checked by a separate run: three executions in turn over one scheduler with `maxParallelism: 1` and `heavy: 1`, every node `done`). Nothing else speaks to either case: the doc comment of `throttledScheduler` does not mention reuse, no test reuses a scheduler at all, and every caller in this repository builds one per execution (dagworkflows' runner calls `throttledScheduler(opts.schedulerOptions)` once for the main pass and once for the post pass). If the shared counts are meant as one limit across executions, the missing wake-up across executions is a bug; if not, the rule is one `throttledScheduler(...)` per execution that may overlap another, and nothing enforces it. Which is intended?

3. **A scheduler that resolves before `hasWork()` is false** makes `execute` resolve early with only the results settled so far (verified: an empty array while a node was still running). Nothing refuses it.
4. **Cyclic node data** passed to `orchestrate` makes it reject with `RangeError: Maximum call stack size exceeded` instead of a named error. A `Graph` cannot hold a cycle, so this only matters for hand-built node data.
5. **Duplicate node names** in `orchestrate`'s input are not refused; the results hold one entry for the name. A `Graph` refuses duplicates.
6. **A `RunNode` that resolves a result after the cancel** (a remote worker that never saw the signal) keeps that result: orchestration overrides only rejections with `cancelled`. Intended, presumably, but not pinned by a test.
7. **Stability of orchestration across versions.** Nothing in the code or tests pins the ready order or the sequence of `run` calls across dagraph releases, which a Temporal workflow history recorded under one version and replayed under another would need. The tests pin the order within one version only. Should a release that changes it be marked as breaking, so that integrators know when the replay and rollout steps under `orchestrate` matter? Until that is settled, they apply to every upgrade.
