# Run a graph

`execute` walks a graph for you. It starts each node once its dependencies have settled, takes what it can from the cache, runs the rest under your limits, and tells you how every node ended. It joins the engine's two halves, orchestration and processing, described in [How it works](../README.md#how-it-works). The last sections of this page use them apart.

## Execute a graph

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAction, execute, FsCache, Graph, tally } from "@mrmeku/dagraph";
import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";

const fetchPage = defineAction({
  kind: "fetch",
  action: async ({ outputDir }) => {
    const body = join(outputDir, "page.txt");
    await writeFile(body, "a page");
    return { body };
  },
});
const summarize = defineAction({
  kind: "summarize",
  deps: { page: fetchPage },
  action: async ({ depOutputs, outputDir, output }) => {
    output("summarizing\n");
    const summary = join(outputDir, "summary.txt");
    await writeFile(summary, (await depOutputs.page.body.text()).toUpperCase());
    return { summary };
  },
});

const casBaseDir = join(await mkdtemp(join(tmpdir(), "dag-")), "cas");
const fs = createNodeDagFs();
const context = { cache: new FsCache(casBaseDir, fs), fs, casBaseDir };
const graph = new Graph();
summarize.addNode(graph, { deps: { page: fetchPage.addNode(graph, {}) } });

console.log(tally(await execute(graph, context))); // done: 2
console.log(tally(await execute(graph, context))); // cached: 2
```

`execute(graph, context, options)` resolves once every node has settled, to one result per node. You build the context once and execute graph after graph against it. Its `cache` maps action keys to entries: `new FsCache(directory, fs)` keeps them on disk, and `new MemCache()` keeps them in memory for tests. Its `fs` is the file system the engine reads, hashes and moves outputs with: `createNodeDagFs()` from [`@mrmeku/dagraph/fs/node`](api/fs/node.md), or `createMemoryDagFs()` in tests. `casBaseDir` is where each key gets its outputs. `ports` holds your actions' tools, and you need it only when they declare some ([Build a graph](graphs.md)).

Every result has the node's `name`, its `actionKey` and one of five statuses:

- `done`: the action ran. Its `outputs` hold the paths it returned, moved under `casBaseDir`, so you can read the files straight from the result.
- `cached`: a verified entry was found, so the action never started. Its `outputs` are the entry's.
- `failed`: the node could not be keyed, or its action threw, timed out or returned bad paths. `error` says why.
- `dep-failed`: a required dependency did not succeed, and `dep` names it.
- `cancelled`: the execution was cancelled before or while the node ran.

`tally(results)` counts the statuses, and `isSucceeded(result)` narrows a result to one that has `outputs`. `execute` never rejects because a node failed: a failure is a result like any other.

## Failures

A failure holds back only the nodes that need it. Say `top` feeds `left` and `right`, which both feed `bottom`, and `left` fails. Then `top` and `right` are `done`, `left` is `failed`, and `bottom` is `dep-failed` with `dep: "left"`. Other branches carry on. A dependency declared with `settled(...)` is waited for but not required, so its dependent runs anyway and reads `undefined` for it ([Build a graph](graphs.md)).

Nothing that fails is cached. The next execution retries the failed node and those it held back, and finds the rest `cached`. So it resumes where the last one stopped ([When a node runs again](caching.md)).

A result is plain JSON, so you can write it to a file or send it to another process. That is why a failure's `error` keeps only the thrown error's `name`, `message` and `cause`. Put what a caller needs in `cause`.

## Limit parallelism

The default scheduler admits every ready node at once. To set limits, bind your concurrency groups when you define actions, and pass the same limits to `throttledScheduler`:

```ts
import { actionsFor, throttledScheduler } from "@mrmeku/dagraph";

const limits = { network: 4, heavy: 1 };
const defineLimitedAction = actionsFor<unknown, keyof typeof limits>();
const scheduler = throttledScheduler({ maxParallelism: 8, concurrencyLimits: limits });
await execute(graph, context, { scheduler });
```

Define `summarize` in the example with `defineLimitedAction` and `concurrencyGroup: "heavy"`, and add several summary nodes, each with a `name` of its own. At most one of them runs at a time. `maxParallelism` caps the nodes being looked up or run at once. Each group in `concurrencyLimits` caps its own running actions. A cache hit never takes a group's slot, so a cached `heavy` node costs nothing against `heavy: 1`.

## Watch events

Run the example's first execution with `{ onEvent: (event) => console.log(event.type, event.node), scheduler: throttledScheduler({ maxParallelism: 1 }) }`. It prints `dispatch fetch`, `start fetch`, `result fetch`, `dispatch summarize`, `start summarize`, `output summarize`, `result summarize`. Each node's events come in that order: `dispatch`, `start`, any `output`s, `result`. Events of different nodes interleave. A cached node gets only `dispatch` and `result`, since a hit never starts. An `output` event carries the `chunk` the action passed to `output()`, and a `result` event carries the `result`.

A listener that returns a promise on `start` holds the action until it resolves. So a journal can record a start before the action has any effect: `onEvent: (event) => journal.record(event)`.

## Time out and cancel

Give an action `timeoutMs` to bound each of its nodes. The clock starts when the action starts. When it runs out, the action's `signal` aborts and the node fails with a `TimeoutError`, and is never cached. The timeout is cooperative: the engine waits for the action to settle, so an action that ignores its `signal` runs to its end. To stop on time, pass `signal` to every call that takes one, such as `fetch` or `spawn`, and call `signal.throwIfAborted()` between steps that take none.

To cancel the whole execution, pass a `signal` to `execute`. This one fires on Ctrl-C or after ten minutes:

```ts
const controller = new AbortController();
process.on("SIGINT", () => controller.abort());
const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]);
console.log(tally(await execute(graph, context, { signal })));
```

Once it aborts, nothing new starts: every ready node, and every node that would have become ready, settles `cancelled`. A running action sees the abort through its own `signal`, and its node settles `cancelled` too, with nothing cached. As with a timeout, the engine waits for running actions to settle. `execute` still resolves with one result per node.

## Write your own executor

`execute` is `orchestrate`, the scheduling half, run over `graph.describe()`, with `localRunNode(graph, context)` as the `RunNode` that processes each node. Processing is two steps. `lookupNode` computes the node's key and checks the cache, and resolves to the node's result or to a miss. On a miss, `runAction` runs the action and stores what it made. `localRunNode` waits for the node's slot between the two, since only a miss takes one.

Write the `RunNode` yourself to change what happens to each node. It may return a result recorded earlier instead of processing the node, as a replay does. This executor replays `fetch` from an earlier execution and processes the rest. Run it after the example's two executions, against the same `context`:

```ts
import { localRunNode, orchestrate, throttledScheduler } from "@mrmeku/dagraph";

const recorded = (await execute(graph, context)).find((result) => result.name === "fetch");
const runNode = localRunNode(graph, context);
const results = await orchestrate(
  graph.describe(),
  (node, depEntries, waitForSlot) =>
    node.name === "fetch" && recorded
      ? Promise.resolve(recorded)
      : runNode(node, depEntries, waitForSlot),
  throttledScheduler({ maxParallelism: 4 }),
);
// fetch is the recorded result; summarize is processed, and cached.
```

A `RunNode` gets three things. The first is the node as data. The second is `depEntries`, the cache entry of each dependency that succeeded, by name. The third is `waitForSlot`, which resolves once the node's group has a slot.

The example leaves out `signal` and `onEvent`. In your executor, pass both to both halves, as `execute` does: `orchestrate(nodes, run, scheduler, onEvent, signal)` takes them last, and `localRunNode` among its options. `orchestrate`'s listener then gets `dispatch` and `result`, and the processing gets `start` and `output`. A signal given to `orchestrate` alone never reaches running actions.

## Process nodes in workers

To process nodes in worker processes, the `RunNode` makes two requests. First it asks a worker to look the node up. It sends the node's name and `depEntries`, and the worker rebuilds a graph that declares the node and calls `lookupNode`. A miss comes back as `status: "missed"`. Any other lookup is the node's result, so a hit never takes a slot.

On a miss, the `RunNode` awaits `waitForSlot()` in the orchestrator, then sends the same request to run. The worker calls `processNode`, which looks the node up again and runs its action, since the orchestrator already holds the slot. It sends back the `Result` as JSON, which `isResult` checks. `start` and `output` fire in the worker, so a journal that records starts listens on the worker's `processNode`, and the cancel goes there too, as its `signal`.

The worker must declare the node the way the original graph does, with the same `kind`, inputs, roles and names. Then it computes the same key and finds the node's dependencies by name. The workers share one CAS, and one `Cache`, such as an `FsCache` over a shared directory, to hit each other's entries. The orchestrator reads no files and needs neither.

## Orchestrate in a sandbox

`orchestrate` reads no clock, draws no random number and does no I/O. What it does depends only on the node data, the scheduler, and the results its `RunNode` resolves to. So a workflow engine that replays a recorded history, such as Temporal, replays the orchestration the same way, with the `RunNode` returning each recorded result.

The package index, `@mrmeku/dagraph`, imports no I/O module, so orchestration bundles into a sandbox that allows none, such as a Temporal workflow. Build the graph outside the sandbox and pass `graph.describe()` in as data: as the workflow's argument, or as an activity's result. Every field of node data but `meta` is plain JSON. Sandboxed code imports the index alone and runs `orchestrate` on that data, with a `RunNode` that calls a worker or, under Temporal, an activity.
