# dagraph: executing graphs

## The problem, and the idea

A graph (see [dagraph-graphs](dagraph-graphs.md)) is a set of nodes, each one use of an action, wired by deps. Building it does nothing. Something has to walk it: start each node once its deps are done, skip the nodes whose earlier output is still good, run the rest, keep heavy work under a limit, stop cleanly on Ctrl-C, and tell the caller what happened to every node.

dagraph splits that walk in two halves:

- **Orchestration** decides _when_: it tracks which nodes are ready, asks a **scheduler** which of them to admit, hands each admitted node the details of its deps that succeeded, and records how it settled. It works on nodes as plain data, never reads details and does no I/O, so it can run inside a sandbox such as a Temporal workflow.
- **Lookup-or-run** decides _what_: for one node it computes the action key, looks the key up in the cache, and on a miss runs the action and stores what it made (the key belongs to [dagraph-graphs](dagraph-graphs.md), the cache to [dagraph-caching](dagraph-caching.md)).

`execute` glues both halves together in one process. `orchestrate` and lookup-or-run's functions (`lookupNode`, `runAction`, and `lookupOrRunNode`, which joins them) are the halves on their own, for an executor that looks nodes up and runs them somewhere else.

Each half is a component of its own, a directory with its ports: `orchestration/`, whose `Scheduler` port the strategies of `schedulers/` fill, and `lookup-or-run/`. `json/` holds the JSON both build on. `execute.ts` is an executor, which wires components together, not a component. This page gives each a section; [dagraph-graphs](dagraph-graphs.md) ("The package") lists the components and their import edges.

Every node ends with exactly one **result**: plain data that says whether the node succeeded (`succeeded`), failed (`failed`), was held back by a failed dep (`dep-failed`) or was cancelled (`cancelled`). Orchestration's `Result` is a generic envelope that names nothing of the cache or the action; lookup-or-run fills it in as a `NodeResult`, whose details say whether the action ran or the node was found in the cache (`details.actionRan`). A failure never stops the rest of the graph. Only the nodes that need the failed node are held back.

Terms used below:

| Term              | Meaning                                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settle            | A node settles when it gets its result. It settles once.                                                                                                                                                |
| Ready             | A node is ready once every one of its deps has settled, whatever their results.                                                                                                                         |
| Dispatch          | Orchestration hands a ready node to whatever runs it: under `execute`, lookup-or-run.                                                                                                                   |
| Hit / miss        | Lookup-or-run found a verified cache entry for the node's key, or did not.                                                                                                                              |
| Start             | On a miss, the moment the action is about to run. A hit never starts.                                                                                                                                   |
| Place             | A unit of the scheduler's global limit (`maxParallelism`). A node holds one from dispatch until it settles, except that a miss in a concurrency group gives its place back while it waits for its slot. |
| Slot              | A unit of a concurrency group's limit. Only a miss in a group takes one, just before it starts.                                                                                                         |
| Execution         | One call of `execute` (or of `orchestrate`): one walk of a graph, from its first dispatch to its last result. Its options (`scheduler`, `signal`, …) last for that call only.                           |
| Executor          | Whatever drives an execution: `execute` itself, or code of your own that calls `orchestrate` with a `RunNode`, for example one that looks nodes up and runs them in worker processes.                   |
| Execution context | What the caller hands the engine: file system, cache directory, clock, timer, forced keys and ports. It outlives any one execution.                                                                     |

Where it lives: `packages/dagraph/src/execute.ts`, `orchestration/orchestrate.ts`, `lookup-or-run/lookup-or-run.ts`.

## The public surface

All of these are exported from the package index, `@mrmeku/dagraph`:

| Name                                                                         | Kind           | What it is                                                                                                    |
| ---------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `execute(graph, executionContext, options?)`                                 | function       | Runs a whole graph in this process. Resolves to one `NodeResult` per node.                                    |
| `ExecuteOptions`                                                             | type           | `{ onEvent?, scheduler?, signal? }`.                                                                          |
| `ExecutionContext<Ports>`                                                    | type           | `{ fs, cacheDir, clock, startTimer, forcedKeys?, ports }`.                                                    |
| `StartTimer`, `startGlobalTimer`                                             | type, constant | What `startTimer` is, `(ms, onTimeout) => stop`, and the one built on the global timers.                      |
| `wallClock`                                                                  | constant       | The `Clock` built on the global `Date`.                                                                       |
| `orchestrate(nodes, run, scheduler, clock, onEvent?, signal?)`               | function       | The scheduling half, over node data. Resolves to one `Result` per node.                                       |
| `ScheduledNode<Meta = unknown>`                                              | type           | The node as orchestration schedules it: `{ name, deps, settledDeps?, concurrencyGroup?, meta? }`.             |
| `requiredDeps(node)`                                                         | function       | A scheduled node's deps minus its settled ones.                                                               |
| `RunNode<NodeData, SuccessDetails, FailureDetails, CancellationDetails>`     | type           | The function `orchestrate` calls to run one node, given the node as `orchestrate` was given it.               |
| `lookupNode(graph, name, depEntries, executionContext)`                      | function       | Computes a node's key and checks its entry. Resolves to a `Lookup`: a result, or a `Miss`.                    |
| `runAction(graph, miss, depEntries, executionContext, options?)`             | function       | Runs a missed node's action and stores what it made. Resolves to its `NodeResult`.                            |
| `lookupOrRunNode(graph, name, depEntries, executionContext, options?)`       | function       | `lookupNode`, then `runAction` on a miss, with no slot to wait for.                                           |
| `runNode(graph, executionContext, options?)`                                 | function       | The `RunNode` that `execute` uses: lookup, the slot on a miss, then the action.                               |
| `Lookup`, `Miss`, `RunActionOptions<Meta>`                                   | types          | A lookup's outcome, a miss (`{ name, actionKey, status: "missed" }`), and `{ signal?, onEvent? }`.            |
| `NodeResult`, `SucceededNodeDetails`, `HitDetails`                           | types          | Lookup-or-run's result, `Result<SucceededNodeDetails, FailedNodeDetails, CancelledNodeDetails>`, and details. |
| `FailedNodeDetails`, `CancelledNodeDetails`                                  | types          | What lookup-or-run reports after a failure or a cancel: the key and, once the action ran, `elapsed`.          |
| `isNodeResult(value)`, `resultActionKey(result)`                             | functions      | The guard for a `NodeResult` read back, and the action key a result carries on any status.                    |
| `unboundedScheduler()`                                                       | function       | The default scheduler: no limits.                                                                             |
| `throttledScheduler(options?)`                                               | function       | A scheduler with a global limit and one limit per concurrency group.                                          |
| `ThrottledSchedulerOptions`                                                  | type           | `{ maxParallelism?, concurrencyLimits? }`.                                                                    |
| `Scheduler`, `SchedulerContext<NodeData>`, `Ready<NodeData>`                 | types          | For writing a scheduler of your own. `NodeData` is the node type, `ScheduledNode` by default.                 |
| `Result<SuccessDetails, FailureDetails, CancellationDetails>`                | type           | Orchestration's result envelope.                                                                              |
| `FailureError`, `JsonValue`                                                  | types          | A failure's `error`, and a value as JSON holds it.                                                            |
| `isResult(value, isSuccessDetails, isFailureDetails, isCancellationDetails)` | function       | The guard for an envelope read back, each part checked by its own guard.                                      |
| `isSucceeded(result)`                                                        | function       | Whether a result succeeded; narrows it to the `succeeded` member.                                             |
| `countResultsByStatus(results)`, `Tally`                                     | function, type | Counts results, or anything with a `status`, by status.                                                       |
| `Clock`                                                                      | type           | What `ExecutionContext.clock` and `orchestrate` read the time from.                                           |
| `OrchestrationEvent`, `OrchestrationListener`                                | types          | Orchestration's events (`dispatch`, `pending`, `result`) and their listener.                                  |
| `ActionEvent<Meta>`, `ActionListener<Meta>`                                  | types          | Lookup-or-run's events (`start`, `output`) and their listener.                                                |
| `ExecutionEvent<Meta>`, `ExecutionListener<Meta>`                            | types          | The union of both, the stream `execute` reports, and its listener.                                            |

The file system implementations live on subpaths so that the index reaches no I/O module: `@mrmeku/dagraph/fs` exports `createBunFileSystem()` (Bun) and `@mrmeku/dagraph/fs/node` exports `createNodeFileSystem()` (Node). `createMemoryFileSystem()`, an in-memory file system for tests, is exported from the index ([dagraph-caching](dagraph-caching.md)).

Where it lives: `packages/dagraph/src/index.ts`, `package.json` (`exports`).

## `execute.ts`: `execute`

`execute.ts` is an executor, not a component: it wires orchestration, lookup-or-run's `runNode` and, unless the options give another scheduler, `unboundedScheduler` together in one process, and may import every component. It exports `execute`, `ExecuteOptions`, `ExecutionEvent`, `ExecutionListener`, `startGlobalTimer` and `wallClock`, which the package index publishes. Each component's tests are in its directory, and `src/execute.test.ts` runs whole graphs. Every test is an executor of its own: it wires what it tests.

`execute(graph, executionContext, options)` runs every node of `graph` in this process and resolves, once every node has settled, to an array of results, one per node, **in the order the nodes settled**. Under the default scheduler several nodes run at once, so that order can differ from run to run. Pass a subgraph view and only its nodes (with the nodes they depend on) are executed; that view is [dagraph-graphs](dagraph-graphs.md)'s.

`execute` does not reject because a node failed. A failure is a result like any other: inspect the results, for example with `countResultsByStatus`. It rejects in three cases only:

- A `dispatch` or `result` listener threw or rejected (see "Events and listeners"). A throw on `start` fails just that node.
- The scheduler itself threw or rejected, for example a bug in one passed as `options.scheduler`. `execute` rejects with that error and returns no results, while the nodes already dispatched keep running with nobody watching.
- The node data is broken (see `orchestrate`), which a `Graph` never produces.

The options, all optional:

| Option      | Default                | Effect                                                             |
| ----------- | ---------------------- | ------------------------------------------------------------------ |
| `onEvent`   | none                   | An `ExecutionListener` that receives every event of the execution. |
| `scheduler` | `unboundedScheduler()` | The policy that admits ready nodes.                                |
| `signal`    | none                   | An `AbortSignal` that cancels the execution.                       |

### The execution context

`ExecutionContext<Ports>` is lookup-or-run's, and has six fields:

- `fs`: a `FileSystem`, the cache's port: the file system the engine reads, hashes and moves files with.
- `cacheDir`: the cache's directory, relative or absolute ([dagraph-caching](dagraph-caching.md), "The cache directory layout").
- `clock`: what the engine reads the time from, a `Clock`, orchestration's minimal port `{ epochMilliseconds: () => number }`, named as Temporal names milliseconds since the Unix epoch. `wallClock` fills it from `Date`, and any other clock, such as one on the Temporal API, fills it with a one-line adapter. It stamps every event's `occurredAt`, measures `elapsed` (see "Lookup-or-run's results" and "Events and listeners") and stamps each hit's and commit's last use ([dagraph-caching](dagraph-caching.md), "Terms"); `execute` hands it to `orchestrate` too. Required, with no default: a caller passes `wallClock` for the wall clock, and a test a fake one to pin times.
- `startTimer`: a `StartTimer`, `(ms, onTimeout) => stop`, lookup-or-run's port for a node's timer. For a node with a `timeoutMs`, it starts the timer just before the action is called and calls the stop it returned once the action settles (see "Timeouts"). Required, with no default: a caller passes `startGlobalTimer`, built on the global `setTimeout` and `clearTimeout`, and a test may pass one of its own that fires the timeout by hand.
- `forcedKeys` (optional): `"all"`, or a set of action keys, whose nodes run again ([dagraph-caching](dagraph-caching.md), "Running again and forcing").
- `ports`: the tools the actions use, passed through to each action as `ports`. It is required when the graph's actions declare ports, and optional (and may be left out) when they need none.

The same context is meant to serve many executions: a CLI builds it once and executes graph after graph against it. Ports go in the context, never in the graph. The cache, its layout and the file system are [dagraph-caching](dagraph-caching.md)'s.

Because ports arrive only through the context, the same graph runs against real tools in production and against stubs or mocks in a test: give the test's context a `ports` object of the same type holding fakes. To test one action, add one node of it to a fresh `Graph` and `execute` it against `createMemoryFileSystem()` (seeded with any input files), a `cacheDir` such as `"/cache"` and fake ports, then read the result's `details.entry.outputs` back through the memory filesystem's `.files`, whose values hold each file's `data`. The worked example on [dagraph-graphs](dagraph-graphs.md) runs this way. `lookupOrRunNode(graph, name, {}, context)` does the same for one node without an executor.

A test of one action in that form (verified: it passes under `bun test` with Bun 1.4.4, and type-checks under the repository's `tsconfig.json` with both TypeScript 6.0.3 and `tsgo`):

```ts
import { expect, test } from "bun:test";
import {
  actionsFor,
  startGlobalTimer,
  wallClock,
  createMemoryFileSystem,
  execute,
  file,
  Graph,
  namedOutput,
  nodeInputs,
  type FileInput,
  type FileSystem,
} from "@mrmeku/dagraph";

interface Ports {
  fs: FileSystem;
  translator: { translate(text: string, language: string): Promise<string> };
}
const defineActionWithPorts = actionsFor<Ports>();

const translate = defineActionWithPorts({
  kind: "translate",
  inputs: { version: 1 },
  nodeInputs: nodeInputs<{ page: FileInput; language: string }>,
  action: async ({ inputs, outputDir, ports }) => {
    const text = await ports.translator.translate(await inputs.page.text(), inputs.language);
    const page = `${outputDir}/page.${inputs.language}.txt`;
    await ports.fs.writeText(page, text);
    return { page };
  },
});

test("translate writes the page in the language it is given", async () => {
  const fs = createMemoryFileSystem({ "/page.txt": "hello" });
  const translator = {
    translate: async (text: string, language: string) => `${language}: ${text}`,
  };
  const graph = new Graph<Ports>();
  translate.addNode(graph, { inputs: { page: file("/page.txt"), language: "fr" } });

  const [result] = await execute(graph, {
    ports: { fs, translator },
    fs,
    cacheDir: "/cache",
    clock: wallClock,
    startTimer: startGlobalTimer,
  });

  if (result?.status !== "succeeded") throw new Error(JSON.stringify(result));
  expect(fs.files.get(namedOutput(result.details.entry.outputs, "page"))?.data).toBe("fr: hello");
});
```

What it relies on:

- The action writes through its `fs` port, and the test passes the same memory file system as the port and as the context's `fs`, so the engine finds, hashes and moves what the action wrote. An action that writes with `node:fs` directly cannot run against the memory file system: its `ensureDir` does nothing, so the output directory does not exist on disk, the write fails, and the node settles `failed` with `ENOENT: no such file or directory, open '/cache/tmp/<uuid>/<file>'` (checked by a separate run).
- After the execution, `.files` holds the seeded `/page.txt`, the one committed output, `/cache/v1/<actionKey>/<contentHash>/page.fr.txt`, and its entry, `/cache/v1/<actionKey>/manifest.json`.
- `namedOutput(outputs, name)` picks one path out of `outputs` ([dagraph-graphs](dagraph-graphs.md)). It needs the result narrowed to a success first, which the `if` does. On any other status it fails the test with the whole result as its message: a translator that throws `quota exceeded` gives `{"name":"translate","status":"failed","error":{"name":"Error","message":"quota exceeded"},"details":{"actionKey":"<64 hex>","elapsed":<ms>}}`, and the file system then holds only `/page.txt`.
- `await lookupOrRunNode(graph, "translate", {}, context)` in place of `execute` returns the same `succeeded` result, its action ran, with the same key and outputs (checked by a separate run).

### Worked example

Two actions: `fetch` writes a page, `summarize` reads it. The second execution finds both nodes in the cache.

```ts
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startGlobalTimer,
  wallClock,
  countResultsByStatus,
  defineAction,
  execute,
  Graph,
  nodeInputs,
} from "@mrmeku/dagraph";
import { createNodeFileSystem } from "@mrmeku/dagraph/fs/node";

const fetchPage = defineAction({
  kind: "fetch",
  nodeInputs: nodeInputs<{ url: string }>,
  action: async ({ inputs, outputDir }) => {
    const page = join(outputDir, "page.txt");
    await writeFile(page, `page ${inputs.url}`);
    return { page };
  },
});
const summarize = defineAction({
  kind: "summarize",
  deps: { page: fetchPage },
  action: async ({ depOutputs, outputDir, output }) => {
    const text = await depOutputs.page.page.text();
    output(`summarizing ${text.length} chars\n`);
    const summary = join(outputDir, "summary.txt");
    await writeFile(summary, text.toUpperCase());
    return { summary };
  },
});

const cacheDir = join(await mkdtemp(join(tmpdir(), "dag-")), "cache");
const fs = createNodeFileSystem();
const context = { fs, cacheDir, clock: wallClock, startTimer: startGlobalTimer };
const graph = new Graph();
const page = fetchPage.addNode(graph, { name: "fetch", inputs: { url: "https://example.com" } });
summarize.addNode(graph, { name: "summarize", deps: { page } });

console.log(countResultsByStatus(await execute(graph, context)));
console.log(countResultsByStatus(await execute(graph, context)));
```

It prints (verified with Bun):

```
{ succeeded: 2, failed: 0, cancelled: 0, "dep-failed": 0 }
{ succeeded: 2, failed: 0, cancelled: 0, "dep-failed": 0 }
```

Both executions succeed; what tells them apart is each result's `details.actionRan`, `true` for both nodes the first time and `false` the second.

With `onEvent: (e) => console.log(e.type, e.node)` and `scheduler: throttledScheduler({ maxParallelism: 1 })` on the first execution, the events are `dispatch fetch`, `start fetch`, `result fetch`, `dispatch summarize`, `start summarize`, `output summarize`, `result summarize`. On the second execution the nodes only get `dispatch` and `result`, since a hit never starts.

Where it lives: `packages/dagraph/src/execute.ts`, `lookup-or-run/lookup-or-run.ts` (`ExecutionContext`), `lookup-or-run/ports.ts` (`StartTimer`), `filesystem/memory.ts`.

## The life of a node

A node moves through these states. Each arrow names what moves it.

1. **Waiting**: some dep has not settled. A node with no deps skips this state.
2. **Ready**: every dep has settled, whatever its status. The node waits for the scheduler to admit it.
3. **Admitted**. Orchestration first checks the node's _required_ deps (every dep but those marked `settled`). If one did not succeed, the node settles `dep-failed` at once, with no dispatch event and no action key. Otherwise orchestration emits `dispatch` and hands the node to its `RunNode`: under `execute`, lookup-or-run.
4. **Looking up**. Lookup-or-run computes the action key. If that fails (an input file cannot be read), the node settles `failed`, with no details and so no action key. Unless the node is not cacheable or its key is forced, it reads the key's entry. A verified entry settles the node `succeeded` with a hit's details (`actionRan: false`). An entry that cannot be read counts as a miss, never as a failure.
5. **Waiting for its slot**: only a miss whose action is in a concurrency group. It gives its place back and waits until the scheduler grants it a slot.
6. **Starting**: the engine makes a fresh, empty output directory for this attempt and emits `start`. If the listener returns a promise, the action waits for it.
7. **Running**: the engine resolves the action's inputs and its deps' outputs to handles (a failure here fails the node without running the action), reads its clock, and runs the action with a signal that fires on the node's timeout or on the execution's cancel.
8. **Settled**: `succeeded` with `actionRan: true` (outputs stored, entry written unless the node is not cacheable), `failed`, or `cancelled`.

A node that does not succeed never gets a cache entry, so its next execution starts it again. If it fails or is cancelled before its outputs are committed, its attempt's directory is removed (best effort: a failed removal changes nothing in the result). The one case that leaves files behind is an entry write that fails. By then the outputs are already committed under `<cacheDir>/v1/<actionKey>/<contentHash>/`, so the node settles `failed` but that directory stays, with no entry pointing at it.

Where it lives: `packages/dagraph/src/orchestration/orchestrate.ts`, `lookup-or-run/lookup-or-run.ts`, `orchestration/exec-state.ts`.

## Results

### Orchestration's envelope

Orchestration's `Result<SuccessDetails, FailureDetails, CancellationDetails>` is how one node settled. It always has `name` (the node's name). The rest depends on `status`:

| `status`     | Extra fields                                   | When                                                                                                              |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `succeeded`  | `details`                                      | The node succeeded. `details` is what whatever ran it made.                                                       |
| `failed`     | `error: { name, message, cause? }`, `details?` | The node failed.                                                                                                  |
| `cancelled`  | `details?`                                     | The execution was cancelled before or while the node ran.                                                         |
| `dep-failed` | `dep`, `rootCauses?`                           | A required dep did not succeed. `dep` names it; `rootCauses` names the nodes behind it (see "Failure semantics"). |

The envelope names nothing of the cache or the action. **Details** are what whatever ran the node reports after a failure or a cancel; orchestration passes it on untouched, and never reads details either. Failed and cancelled results have separate details types, so a cancelled result's details can never carry what only a failure's does. Orchestration builds only results with no details: `dep-failed`, a node cancelled before its dispatch, and a node whose `RunNode` rejected.

### Lookup-or-run's results

Lookup-or-run (`lookupNode`, `runAction`, `lookupOrRunNode`, `runNode`, and so `execute`) fills the envelope in as a `NodeResult`, which is `Result<SucceededNodeDetails, FailedNodeDetails, CancelledNodeDetails>`:

| Type                   | Shape                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `HitDetails`           | `{ actionKey, entry, actionRan: false }`: a verified cache entry was found.                                      |
| `SucceededNodeDetails` | a `HitDetails`, or `{ actionKey, entry, actionRan: true, elapsed }`: the action ran and its outputs were stored. |
| `FailedNodeDetails`    | `{ actionKey }`, or `{ actionKey, elapsed, timedOut? }` once the action ran.                                     |
| `CancelledNodeDetails` | `{ actionKey, elapsed? }`.                                                                                       |

`entry` is the node's cache entry (`CacheEntry`, from [dagraph-caching](dagraph-caching.md)), as `lookupEntry` or `commitEntry` returned it: `outputs` is the record of outputs the action returned, moved to where the cache keeps them, each path absolute, beside `contentHash` and `outputHashes`.

A failure fails for one of these reasons: the node could not be keyed, or its action threw, timed out, or returned paths outside its output directory, not regular files or not readable, or the work around it failed.

`elapsed` is there **exactly when the engine ran the node's action**: always on details with `actionRan: true`, on a failure's details when the failure came from the action or after it, and on a cancel's details when the cancel caught the action running. It is in milliseconds by the context's clock, counted from just before the action is called (after the `start` event, its listener and the input resolution) to the result, so it includes hashing and storing the outputs. A node that failed or was cancelled before its action ran has no `elapsed`: one whose attempt directory could not be made, whose inputs could not be resolved, whose `start` listener rejected, or that a cancel held back before the action.

`timedOut: true` is on a failure's details exactly when the node's own `timeoutMs` fired (see "Timeouts"), and only beside `elapsed`. An action that throws a `TimeoutError` of its own, as `fetch` given `AbortSignal.timeout(ms)` does, fails with that `error.name` but no `timedOut`, so `timedOut`, not the error's name, tells the two apart.

The types require `Outputs`: a record of named outputs, each a path or a list of paths. A value cast past the types, such as a bare path, fails the node (see Failure semantics).

**Which results carry a key.** Every details, and the details of every failed or cancelled result, carry the node's `actionKey`. A result has none when the node never got one: a `dep-failed` node, a node cancelled before it was dispatched, a node whose key could not be computed (it fails with no details), and a node whose `RunNode` rejected. A node that was looked up or ran keeps its key, even when it then failed or was cancelled. `resultActionKey(result)` is the one switch that finds the key on any status, or `undefined`; a reader that needs the key across statuses calls it rather than branching itself.

### A result is plain data

A result holds only JSON, so it can be written to a file or sent to another process as it is. The engine builds a failure's `error` from what was thrown, and keeps only its name, message and cause: the stack and any other own property (`code`, `exitCode`, `stderr`, …) are dropped, so whatever a caller needs to see must go in `cause`.

- `name` is the thrown error's name, or `"Error"` when the thrown value is not an `Error`.
- `message` is the error's message, or the thrown value turned into a string (`throw "boom"` gives `{ name: "Error", message: "boom" }`).
- `cause` is the thrown error's own `cause`, converted to JSON. A JSON cause is copied, so changing it afterwards does not change the result; an `undefined` property is dropped and `-0` becomes `0`. An `Error` cause becomes `{ name, message, cause? }`, with its own cause converted the same way, and the chain stops at an error that comes again. Anything else is dropped, and so is the whole cause: a cycle, `NaN`, `Infinity`, a `bigint`, a `Map` or other class instance, an array holding an `undefined` item or a hole, or a cause whose getter throws.

For example, `throw new RangeError("bad exited 1", { cause: { argv: ["bad"], code: 1 } })` gives `{ name: "RangeError", message: "bad exited 1", cause: { argv: ["bad"], code: 1 } }`.

A hit, as JSON:

```json
{
  "name": "fetch-b",
  "status": "succeeded",
  "details": {
    "actionKey": "42a8d5ee…43756",
    "entry": {
      "outputs": { "page": "<cacheDir, absolute>/v1/42a8d5ee…43756/c844d585…44b6/page.txt" },
      "contentHash": "c844d585…44b6",
      "outputHashes": { "page": "<64 hex>" }
    },
    "actionRan": false
  }
}
```

### Helpers

- `isResult(value, isSuccessDetails, isFailureDetails, isCancellationDetails)` tells whether a value read back from a file or another process is a `Result`, and passes each part to its guard. It checks the envelope: every result needs `name` as a string; `succeeded` a `details` its guard accepts; `failed` an `error` whose `name` and `message` are strings and whose `cause`, if any, is JSON, and a `details`, if any, its guard accepts; `cancelled` a `details`, if any, its guard accepts; `dep-failed` a `dep` string and, if any, `rootCauses` an array of strings. An unknown status is refused.
- `isNodeResult(value)` is `isResult` with lookup-or-run's guards. Details needs `actionKey`, an `entry` that is a `CacheEntry`, and `actionRan` either `false` or `true` with a numeric `elapsed`. Details needs `actionKey`; `elapsed`, when there, is a number, and a failure's `timedOut`, when there, is `true` beside `elapsed`. It reads the current shape only: a result an earlier version wrote (`done`, `cached`, a top-level `actionKey` or `elapsed`) is refused, so a file of persisted results in an older shape starts cold.
- `isSucceeded(result)` is true for `succeeded`, and narrows the result to that member, which carries its `details`.
- `FailureError` is the type of a failed result's `error`.
- `countResultsByStatus(results)` counts results by status. It reads only `status`, so it takes any iterable of `{ status }` with one of orchestration's four statuses, such as dagworkflows' node reports. It returns a `Tally`, a record with all four statuses as keys, zero when none: `{ succeeded, failed, cancelled, "dep-failed" }`. To tell builds from hits, count `details.actionRan` among the succeeded.

Where it lives: `packages/dagraph/src/orchestration/types.ts` (the envelope, `isResult`, `isSucceeded`, `countResultsByStatus`), `orchestration/errors.ts` (`failureErrorOf`, how a thrown value becomes a failure's `error`), `lookup-or-run/lookup-or-run.ts` (`NodeResult` and its parts, `isNodeResult`, `resultActionKey`), `json/json.ts`.

## Failure semantics

**A failure holds back only what needs it.** When a node fails, every node that requires it settles `dep-failed`, and so does every node that requires those, transitively. Nodes on other branches carry on. There is no fail-fast mode. For example, with `top → left, right → bottom` where `left` fails: `top` and `right` succeed, `left` is `failed`, and `bottom` is `dep-failed` with `dep: "left"`. Further down a chain, `dep` names the direct dep: in `bad_root → mid → leaf`, `mid` has `dep: "bad_root"` and `leaf` has `dep: "mid"`.

When a node has several deps that did not succeed, `dep` names the first of them in the node's dep order (the order its roles were given).

**A held back node names its root causes.** A `dep-failed` result settled by orchestration carries `rootCauses`: the nodes upstream along required deps that did not succeed and were not held back themselves (they `failed`, or were `cancelled`), reached through any held back deps in between. Each is named once, in the node's dep order, a held back dep's own root causes taking its place. In `bad → mid → leaf`, both `mid` and `leaf` have `rootCauses: ["bad"]`, while `leaf`'s `dep` is `"mid"`. A node that requires `mid`, a failed `worse` and `bad` has `rootCauses: ["bad", "worse"]`. A `settled` dep is never one, even when it failed. So a node held back always names at least one root cause. A held back dep whose result has no `rootCauses`, which only a `RunNode` that returns a `dep-failed` result itself can give, counts as a root cause of its own. `lookupNode`'s own `dep-failed` result has none: it sees only the dep entries it is given.

**A `settled` dep never holds its node back.** A dep declared with `settled(...)` (see [dagraph-graphs](dagraph-graphs.md)) is waited for, not required: when it does not succeed, its dependent runs without it and its role reads `undefined`. A node that names the same dep in two roles, one plain and one `settled`, still requires it.

**Failures are never cached.** The next execution tries the failed node again, and nodes that were held back with it. An interrupted execution resumes where it stopped: with `a → b → c → d` where `b` fails once, the first execution gives `a: succeeded` (its action ran), `b: failed, c: dep-failed, d: dep-failed`; the second finds `a` in the cache and starts only `b`, `c` and `d`.

**What fails a node, and the message a caller sees:**

| Cause                                                                                                   | `error`                                                                                         | Debrief? |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------- |
| The action throws                                                                                       | its name, message and cause                                                                     | yes      |
| The node's timeout fires                                                                                | `name: "TimeoutError"`, `message: "timed out after <timeoutMs> ms"`, the thrown error's `cause` | yes      |
| An input file cannot be read                                                                            | that error                                                                                      | no       |
| The action returns something other than a record of paths and lists of paths                            | `the action returned <value as JSON>, not a record of outputs: return { <name>: path }`         | yes      |
| A returned path lies outside the output directory                                                       | `output not under the output dir: <path> is not under <outputDir>`                              | yes      |
| A returned path has no file, or cannot be read                                                          | named by [dagraph-caching](dagraph-caching.md)                                                  | yes      |
| An output ref names an output its dep's entry does not hold                                             | `"<node>" has no output "<output>"`, no `elapsed`, the action never runs                        | yes      |
| The `start` listener throws or rejects                                                                  | that error, no `elapsed`, the action never runs                                                 | yes      |
| The output directory cannot be made, or the cache write fails (the committed outputs then stay on disk) | that error, no `elapsed` when the directory could not be made                                   | yes      |
| The output directory cannot be renamed into place ([dagraph-caching](dagraph-caching.md))               | the rename's own error                                                                          | yes      |
| The `RunNode` rejects                                                                                   | its error (or `cancelled` once the execution is cancelled)                                      | no       |

Where it lives: `packages/dagraph/src/orchestration/orchestrate.ts`, `orchestration/exec-state.ts`, `lookup-or-run/lookup-or-run.ts`.

## The order of ready nodes

Orchestration keeps the ready nodes in one ordered list. A scheduler takes from it in that order; it may hold a node back, but it never reorders the list. The order aims to finish one branch before starting the next, so partial work is useful early (for example, one item fully processed rather than every item half done).

The rule:

1. Each node has a **root priority**: the position, in the order the nodes were added, of the earliest-added root (node with no deps) it descends from. A lower number goes first.
2. Among nodes of equal priority, the one that became ready **most recently** goes first. Nodes that became ready together keep the order they were added in.
3. A node that waits for its slot goes back into the list at its own priority, under the same rule.

Worked example. Nodes are added in this order: `r1`, `r2`, `c1` (needs `r1`), `c2` (needs `r1`), `g1` (needs `c1`), `both` (needs `r2` and `c2`). Priorities: `r1`, `c1`, `c2`, `g1` and `both` have 0 (they descend from `r1`), `r2` has 1. With `throttledScheduler({ maxParallelism: 1 })` the nodes start in this order:

```
r1 c1 g1 c2 r2 both
```

`r1` and `r2` are ready first; `r1` wins on priority. When `r1` settles, `c1` and `c2` become ready together, both at priority 0, ahead of `r2`. When `c1` settles, `g1` becomes ready, and as the most recent at priority 0 it goes ahead of `c2`. `both` has priority 0 but is not ready until `r2` settles, so it comes last.

With the default scheduler, everything ready is admitted at once, so the order only decides which lookups and actions begin first. It matters under a limit.

Where it lives: `packages/dagraph/src/orchestration/exec-state.ts`.

## `schedulers/` (no ports: its schedulers fill orchestration's `Scheduler` port)

A **scheduler** is the policy that admits ready nodes. It is a function that orchestration calls once per execution with a `SchedulerContext`, and it resolves when there is no work left. Two are built in, the strategies of `schedulers/`, which fill orchestration's `Scheduler` port. Its one import edge is `orchestration/`, for types only, and its `index.ts` exports `unboundedScheduler`, `throttledScheduler` and `ThrottledSchedulerOptions`, which both the package index and the `./orchestration` entry publish.

### `unboundedScheduler()`

Admits every ready node at once. It is the default of `execute`. Concurrency groups still work under it, but with no limit, a miss is granted its slot as soon as it asks.

### `throttledScheduler(options?)`

A global limit and one limit per concurrency group, like Ninja's `-j` and its pools.

| Option              | Default    | Meaning                                                                                                      |
| ------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| `maxParallelism`    | `Infinity` | The most nodes processed at once: looking up or running. A miss waiting for its group's slot does not count. |
| `concurrencyLimits` | `{}`       | For each group name, the most of its nodes that hold a slot at once. A group with no entry has no limit.     |

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
hit hit               a hit, so no slot needed
dispatch free
granted free          places: holder, free
ran holder
granted waiter        the heavy slot is free again
```

Another: with `{ concurrencyLimits: { heavy: 1 } }` and three roots `root_a`, `root_b`, `root_c` (added in that order), each with a heavy child: when `root_c` finishes first, `heavy_c` gets the slot. Then `root_b` and `root_a` finish, and `heavy_b` asks before `heavy_a`. When `heavy_c` finishes, the slot goes to `heavy_a`, since `root_a` was added first.

A scheduler returned by `throttledScheduler` keeps its counts across calls: they belong to the `throttledScheduler(...)` call, not to one execution. Using it for one execution after another is fine. Shared by executions that run at the same time, it hangs the whole process or one of the executions, and whether that makes sharing a misuse or the hang a bug is not settled (see "Open questions"). Until it is, give each execution that may overlap another a `throttledScheduler(...)` of its own, as every caller in this repository does. Nothing built in then gives one limit across those executions.

Where it lives: `packages/dagraph/src/schedulers/schedulers.ts`, `orchestration/orchestrate.ts`.

### Writing your own scheduler

A `Scheduler` is `async (ctx) => void`, generic in the node type, so it fits any node data. The `SchedulerContext` gives it four functions:

- `take(filter?)` removes and returns the first ready entry, in the ready order, that `filter` admits, or `null`. An entry is a `Ready`: `{ node, pending }`. `node` is the node as `orchestrate` was given it. A scheduler may read only what a `ScheduledNode` holds: `name`, `deps`, `settledDeps`, `concurrencyGroup` and `meta`. `pending` is `false` the first time a node comes, when it is ready to be dispatched, and `true` when it comes again as a node waiting for its slot (under `runNode`, a miss before its action runs), which `throttledScheduler` lets run once its group has a slot.
- `run(ready)` dispatches a ready node, or grants a node waiting for its slot its slot. It resolves once the node settles or, for a node that goes to wait for its slot, once it gives its place back.
- `hasWork()` is true while some node is ready or being processed.
- `workAvailable()` resolves when what `take` returns may have changed: a node settled, a node asked for its slot, or the execution was cancelled. It resolves at once when nothing is being processed.

The rules a scheduler must keep:

- Take nodes in the order `take` gives them. A scheduler only filters; it cannot reorder.
- Keep going until `hasWork()` is false. Orchestration's result is read when the scheduler resolves.
- Eventually run every entry, those waiting for a slot included. A node waits for its slot until its waiting entry is run.
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

One that runs at most one node of each concurrency group at a time, and every node with no group at once, in the same shape as the built-in schedulers (verified: over three nodes in each of two groups and three with none, each group peaked at one running node and the three ungrouped ran together):

```ts
import type { Ready, Scheduler } from "@mrmeku/dagraph";

const onePerGroup: Scheduler = async (ctx) => {
  const running = new Set<string>();
  const admits = ({ node }: Ready) =>
    node.concurrencyGroup === undefined || !running.has(node.concurrencyGroup);
  const dispatch = () => {
    for (let next = ctx.take(admits); next; next = ctx.take(admits)) {
      const group = next.node.concurrencyGroup;
      if (group !== undefined) running.add(group);
      void ctx.run(next).then(() => {
        if (group !== undefined) running.delete(group);
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

This one counts entries, not nodes: a node that waits for its slot gives its place back, which frees its group, and comes back as an entry waiting for its slot, admitted like any other.

Where it lives: `packages/dagraph/src/orchestration/ports.ts` (`Scheduler`, `SchedulerContext`, `Ready`), `orchestration/orchestrate.ts`, `schedulers/schedulers.ts`.

## Events and listeners

An execution reports what happens as one stream of `ExecutionEvent`s: the union of orchestration's `OrchestrationEvent` (`dispatch`, `pending`, `result`) and lookup-or-run's `ActionEvent` (`start`, `output`). Each event has `type`, `node` (the node's name), `occurredAt` and, when the node has one, `meta` (the node's metadata, from [dagraph-graphs](dagraph-graphs.md)). `occurredAt` is when the event happened, in ms since the epoch, read from the clock at the moment it is emitted, before the listener sees it: orchestration stamps `dispatch`, `pending` and `result` from `orchestrate`'s `clock`, lookup-or-run stamps `start` and `output` from the context's `clock`. Under `execute` they are one clock. A listener that is slow to run does not shift the stamp. Each event type is a union that narrows on `type`: a listener reads `event.chunk` after checking `event.type === "output"` and `event.result` after `event.type === "result"`. The types:

| `type`     | Extra            | Emitted by    | When                                                                      |
| ---------- | ---------------- | ------------- | ------------------------------------------------------------------------- |
| `dispatch` | none             | orchestration | The node is handed to whatever runs it.                                   |
| `pending`  | none             | orchestration | A node waiting for its slot is held back until the scheduler lets it run. |
| `start`    | none             | lookup-or-run | On a miss, as the action is about to run.                                 |
| `output`   | `chunk` (string) | lookup-or-run | The action called `output(chunk)` to print something.                     |
| `result`   | `result`         | orchestration | The node settled. Under `execute`, the result is a `NodeResult`.          |

The events of one node come in the order `dispatch`, `pending`, `start`, `output`…, `result`. Events of different nodes interleave, and each is emitted as it happens, so a listener sees a `start` while other nodes still run. What each kind of node gets:

- A node that runs: `dispatch`, `start`, any `output`s, `result`. A node the scheduler may hold back (today, one in a concurrency group) also gets `pending` before its `start`, even when it is let run at once.
- A hit: `dispatch`, `result`.
- A `dep-failed` node, or one cancelled before it was dispatched: `result` only.
- What an action prints after its result came back is dropped: no `output` event follows `result`.

A listener is `(event) => void | Promise<void>`: an `OrchestrationListener` receives orchestration's events, an `ActionListener` lookup-or-run's, and an `ExecutionListener` both. What it returns matters only for some events:

- **`start`**: if it returns a promise, the action runs only once that promise resolves. This lets a journal record the start before the action has any effect: `onEvent: (event) => journal.record(event)`. If the listener throws or the promise rejects, the node fails with that error and its action never runs.
- **`output`**: a returned promise is not awaited, and its rejection is dropped.
- **`dispatch`, `pending` and `result`**: a throw, or a returned promise that rejects before the execution ends, stops nothing. Every node still settles; then `execute` (or `orchestrate`) rejects with the first such error, and its results are not returned. The listener error is checked once, after the scheduler returns, so a promise that rejects after the execution ends is dropped silently and the execution resolves normally.

`ExecutionEvent`, `ExecutionListener`, `ActionEvent` and `ActionListener` default `Meta` to `unknown` (`Graph`'s own `Meta` defaults to `undefined`). So a plain `const onEvent: ExecutionListener = (event) => console.log(event.type, event.node)` can be passed to `execute`, to `orchestrate` over `runNode`'s results, and to `lookupOrRunNode`, for a graph with any `Meta`: a listener of the wider union is a listener of either half. `OrchestrationEvent<Meta, SuccessDetails, FailureDetails, CancellationDetails>` and `OrchestrationListener` take the envelope's parts and have no defaults.

In `execute`, the one `onEvent` gets all five types. With `orchestrate` and lookup-or-run's functions used apart, `orchestrate`'s `onEvent` gets `dispatch`, `pending` and `result`, and the one given to `runAction`, `lookupOrRunNode` or `runNode` gets `start` and `output`.

Where it lives: `packages/dagraph/src/orchestration/types.ts` (`OrchestrationEvent`), `orchestration/ports.ts` (`OrchestrationListener`), `lookup-or-run/ports.ts` (`ActionEvent`, `ActionListener`), `execute.ts` (`ExecutionEvent`, `ExecutionListener`), `orchestration/orchestrate.ts`.

## Timeouts

An action may declare `timeoutMs`: how long it may run, in milliseconds. It must be a whole number from 1 to 2147483647 (the longest delay `setTimeout` honors); otherwise `defineAction` throws `RangeError: action "<kind>": timeoutMs must be a whole number of ms from 1 to 2147483647, got <value>`. The node data carries it as `timeoutMs`.

- The clock starts when the action starts: after the cache lookup, the slot wait, the output directory, the `start` event and the input resolution.
- the engine sets no timer itself: it starts the timer through the context's `startTimer`, and calls the stop `startTimer` returned once the action settles, whether or not the timeout fired. `startGlobalTimer` starts it with the global `setTimeout` and stops it with `clearTimeout`. A node with no `timeoutMs` arms nothing.
- When it runs out, the action's `signal` aborts with a `DOMException` named `"TimeoutError"` (message `"The operation timed out."`).
- The node then fails **whatever the action does next**, even if it returns outputs: `error.name` is `"TimeoutError"`, `error.message` is `"timed out after <timeoutMs> ms"`, `error.cause` is the cause of the error the action threw as it stopped, if any, and the details have `timedOut: true` beside `elapsed`. Only this timer sets `timedOut`; a `TimeoutError` the action throws on its own (a `fetch` under `AbortSignal.timeout`) fails the node with that name and no `timedOut`. The result is never cached, so the next execution runs the node again.
- The timeout is cooperative. The engine does not abandon the action: it waits for the action to settle. An action that ignores its signal runs to its end. No test pins this; a separate run checked it: a 10 ms timeout on an action that ignores its signal and sleeps 200 ms gives `failed` with `TimeoutError` and details' `elapsed` of about 200. How an action stops on time is under "Honouring the signal".
- `timeoutMs` is not part of the action key. Changing it re-keys nothing.

Where it lives: `packages/dagraph/src/lookup-or-run/lookup-or-run.ts` (`actionSignal`), `lookup-or-run/ports.ts` (`StartTimer`), `execute.ts` (`startGlobalTimer`), `graph/define-action.ts`.

## Cancellation

Pass `signal` to cancel an execution, typically from an `AbortController` aborted on Ctrl-C. Once it aborts:

- **Nothing new starts.** Every node that is ready, or becomes ready, settles `cancelled` without being dispatched (no details, so no key; `result` event only). The dependents of a cancelled node settle `cancelled` too, not `dep-failed`.
- **A node waiting for its slot** stops waiting: `waitForScheduler` rejects. Under `runNode`, that miss settles `cancelled` with details that keep its action key, since it was looked up.
- **A running node** sees the cancel through its action's `signal`, whose `reason` is the signal's reason (for example the error passed to `controller.abort(reason)`). Whatever the action then returns, the node settles `cancelled`, its details carrying the `elapsed` of its action, its attempt's directory is removed, and nothing is cached. This matches GitHub's runner: once the signal fired, the action's exit no longer decides.
- **A cancel wins over a timeout.** If the timeout fired first and the cancel lands before the action settles, the node is `cancelled`.
- **A cancel during the steps before the action**, while the output directory is made or while the `start` listener's promise is pending, holds the action back: the node settles `cancelled`, with no `elapsed`, and its action never runs, even though a journal may already have recorded its start.
- **A lookup that hits** still succeeds; a cancel does not undo a hit. A cancel that lands after the action returned, while its outputs are stored, does not undo its success.
- **The results are complete.** `execute` still resolves with one result per node. A signal that is already aborted when `execute` is called gives every node `cancelled` with no `dispatch` and no `start`.

Like a timeout, a cancel is cooperative: the execution ends only once each running action settles (see "Honouring the signal").

**A timeout for the whole execution** is a cancel on a timer: `execute(graph, context, { signal: AbortSignal.timeout(60_000) })`. When it fires, the nodes behave as on any cancel. Verified: with a node `a` that waits on its signal and a dependent `later`, `{ signal: AbortSignal.timeout(50) }` gives `a: cancelled` (its details with its action key, since it was looked up) and `later: cancelled` (no details), counts `{ succeeded: 0, failed: 0, cancelled: 2, "dep-failed": 0 }`. To have both Ctrl-C and a deadline, combine them with `AbortSignal.any([controller.signal, AbortSignal.timeout(ms)])`. A per-node limit is the action's `timeoutMs` instead, which fails the node rather than cancelling it.

An execution removes every listener it added to `signal` when it ends, and each node's timer is stopped once its action settles, through the stop its `startTimer` returned. So one long-lived `AbortSignal`, such as a process-wide Ctrl-C controller, can be passed to many executions in turn without piling up listeners.

A worked example, which `execute.test.ts` and orchestration's cancel test pin in part: `slow` (in the first execution only, waits for its signal, then returns normally), `quick`, `after` (needs `quick`) and `never` (needs `slow`), under `maxParallelism: 2`, with the abort fired from the listener when `quick`'s result arrives. The events are `start:slow`, `start:quick`, `succeeded:quick`, `cancelled:after`, `cancelled:slow`, `cancelled:never`, and the counts are `{ succeeded: 1, failed: 0, cancelled: 3, "dep-failed": 0 }`. Only `quick` and `slow` have an action key. Once `slow` stops waiting, since with no signal it would never resolve, the next execution without a signal finds `quick` in the cache and runs the other three. The order `start:slow`, `start:quick` holds with `createMemoryFileSystem()`; with a real file system the two starts may come in either order.

Where it lives: `packages/dagraph/src/orchestration/orchestrate.ts`, `lookup-or-run/lookup-or-run.ts`.

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
import { startGlobalTimer, wallClock, defineAction, execute, Graph } from "@mrmeku/dagraph";
import { createNodeFileSystem } from "@mrmeku/dagraph/fs/node";

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

const cacheDir = join(await mkdtemp(join(tmpdir(), "dag-")), "cache");
const fs = createNodeFileSystem();
const graph = new Graph();
for (const action of [passOn, steps, tree]) action.addNode(graph, {});
for (const r of await execute(graph, {
  fs,
  cacheDir,
  clock: wallClock,
  startTimer: startGlobalTimer,
}))
  console.log(r.name, r.status, r.status === "failed" ? JSON.stringify(r.error) : "");
```

Under both runtimes it prints the three nodes in the order `pass-on`, `tree`, `steps`, each `failed` with `TimeoutError` and `timed out after 100 ms`, and no `sleep` is left running. Printed as well, the details' `elapsed` is 102 to 110 ms, against the 5000 the work would take. The causes: `pass-on` has `{ name: "TimeoutError", message: "The operation timed out." }`, `tree` has `{ argv: ["sh", "-c", "sleep 5; true"], code: null, killedBy: "SIGTERM" }`, and `steps` has none. Under both, `promisify(execFile)("sh", ["-c", "sleep 5; true"], { signal })` in place of `runTree` settles just as soon, but leaves `sleep` running: `SIGTERM` reached only `sh` (checked by a separate run). On a cancel, an action like `pass-on` without a `timeoutMs` settles `cancelled` 100 ms after `controller.abort()` (checked by a separate run).

Where it lives: `packages/dagraph/src/lookup-or-run/lookup-or-run.ts` (`actionSignal`), `graph/types.ts` (`ActionContext`); `packages/dagworkflows/src/ports/real.ts` (`createExec`).

## `orchestration/` (ports: `RunNode`, `Scheduler`, `Clock`, `OrchestrationListener`)

`orchestration/` settles every node exactly once, in dependency order, as its scheduler admits nodes. It does no I/O and never reads details. Its ports, declared in `orchestration/ports.ts`: `RunNode`, which runs one node (lookup-or-run's `runNode` under `execute`, or an executor's own); `Scheduler`, which admits ready nodes through a `SchedulerContext` of `Ready` entries (the strategies of `schedulers/`, or one of your own); `Clock`, which stamps its events; and `OrchestrationListener`, which receives them. It owns `ScheduledNode` and `requiredDeps`, the generic `Result` with its `FailureError`, `isResult`, `isSucceeded`, `Tally`, `countResultsByStatus` and `OrchestrationEvent`, and `failureErrorOf` and `errorMessage`, which turn a thrown value into a failure's `error` and its message. Its one import edge is `json/`. Its `index.ts` exports all of these; the package index and the `./orchestration` entry publish all but `failureErrorOf` and `errorMessage`.

### `orchestrate`: the scheduling half

`orchestrate(nodes, run, scheduler, clock, onEvent?, signal?)` does what `execute` does, except that it never looks a node up or runs it itself: it calls `run` for that.

- `nodes`: the node data, any iterable of `ScheduledNode` or a type that extends it, usually `graph.describe()`. Orchestration reads only `name`, `deps`, `settledDeps`, `concurrencyGroup` and `meta`, so node data with no `kind` schedules too. It carries no actions or inputs, so it can cross into another process when its `meta` can.
- `run`: a `RunNode<NodeData, SuccessDetails, FailureDetails, CancellationDetails>`, `(node, depDetails, waitForScheduler) => Promise<Result<SuccessDetails, FailureDetails, CancellationDetails>>`. It gets each node as `orchestrate` was given it, so a `run` given graph's nodes reads their `kind`. `depDetails` is the details of each dep that succeeded, by dep name (a dep that did not succeed is absent): orchestration keeps each succeeded result whole and hands out its `details` after narrowing on `status`, without reading it. `waitForScheduler` waits until the scheduler lets the node run on (below). `orchestrate` infers the type arguments from `run`; a call site that passes an arrow whose parameters it cannot infer annotates them.
- `scheduler`: required here; there is no default.
- `clock`: required; stamps the `occurredAt` of the events it emits (`dispatch`, `pending`, `result`). `execute` passes the context's.
- `onEvent`: an `OrchestrationListener`; receives `dispatch`, `pending` and `result`.
- `signal`: cancels, as in `execute`.
- It fills each `dep-failed` result's `rootCauses` from the results it holds.

It resolves to one result per node, in settle order. It does no I/O, never reads details and never sees an action, so it runs inside a sandbox that allows no I/O, such as a Temporal workflow. For the same reason, the package index imports no I/O module; the file systems are on the `fs` subpaths.

`execute` is nothing more than `orchestrate` over `graph.describe()` with `runNode(graph, context, { signal, onEvent })` as its `RunNode`. That passes each dep's `details.entry` to `lookupNode`, and on a miss awaits `waitForScheduler`, then runs the action with `runAction`. A cancel while it waits settles the node `cancelled`, its details with its key. So an executor built from these parts gets the same meaning for every primitive (keys, hits, `settled`, groups, timeouts, cancel, events) as `execute`: the parts are where those meanings live.

**Determinism.** `orchestrate` draws no random number and does no I/O. It reads its `clock` once per event it emits, to stamp it, and for nothing else: no decision it makes depends on the time. What it does depends only on the node data, the scheduler, the results its `RunNode` calls resolve to, and the order in which they resolve. Inside a Temporal workflow, `Date` passed as its clock is the sandbox's, whose `now()` returns the time of the workflow task being run (`@temporalio/workflow` 1.24.0, `lib/global-overrides.js`), so a replay stamps the same times. A workflow engine that replays a recorded history (Temporal) reproduces those, so the orchestration replays the same way. The code makes no promise that the ready order or the calls stay the same across dagraph versions (see "Open questions").

**The built-in schedulers are deterministic too.** `unboundedScheduler()` and `throttledScheduler(...)` read no clock, draw no random number, set no timer and do no I/O: `schedulers/schedulers.ts` imports only types, and its only state is the counts in the closure of a `throttledScheduler(...)` call. What they admit depends only on what `take`, `hasWork` and `workAvailable` return and on when each `run` resolves, so with either of them a Temporal workflow that runs `orchestrate` replays the same way. A scheduler of your own replays only if it keeps the same rule. No test or lint rule pins this; two separate runs checked it:

- Under Bun 1.4.4 and Node 25.8.1, with `Date`, `Math.random`, `performance.now`, every timer function, `queueMicrotask`, `process.nextTick` and `crypto`'s random functions wrapped to record each call, `orchestrate` over three roots, each with a `heavy` child and a plain one, called none of them under either scheduler, `throttledScheduler({ maxParallelism: 2, concurrencyLimits: { heavy: 1 } })` included, and made the same sequence of `run` calls twice. That run came before events were stamped. Since then, the same graph under Bun 1.4.4 makes 21 calls of `Date.now` under either scheduler, with a listener or without, one per event (9 `dispatch`, 3 `pending`, 9 `result`), and no call of `Math.random`, `performance.now`, `setTimeout`, `setInterval`, `queueMicrotask` or `crypto`'s random functions.
- Under `@temporalio/worker` 1.24.0 on Node 25.8.1, `Worker.runReplayHistory` replayed hand-built histories of a workflow that takes `graph.describe()` as its argument and runs `orchestrate` over `r1`, `r2` and `c1` (needs `r1`), with one activity per node whose `activityId` is the node's name. A history in the order the scheduler gives replayed without error, twice: `r1 c1 r2` under `throttledScheduler({ maxParallelism: 1 })`, and `r1` and `r2` in one workflow task, then `c1`, under `unboundedScheduler()`. A history in another order failed with `DeterminismViolationError`, for example `Activity id of scheduled event 'r2' does not match activity id of activity command 'c1'`. Temporal compares activity IDs only when the history's first `WorkflowTaskCompleted` records core flag 1 (`sdkMetadata.coreUsedFlags: [1]`); without it the misordered histories replayed without error too.

**Node data into a Temporal workflow.** `graph.describe()` can go into a workflow as its argument (`args` of `client.workflow.start`) as well as an activity's result. Both pass through the same data converter, whose default writes a value as JSON (`json/plain`), and node data survives JSON whenever its `meta` does ([dagraph-graphs](dagraph-graphs.md), "`describe()`"). Either way the graph is built outside the sandbox: in the client that starts the workflow, or in an activity. Verified: through `defaultPayloadConverter` of `@temporalio/common` 1.24.0, the node data of a graph with meta (`null` included), a `settled` dep, `cacheable: false` and a `timeoutMs` comes back deep-equal, and `orchestrate` over the copy gives the same results; the replays above pass it as the workflow's first argument. A `bigint` in meta makes the converter throw `ValueError: Unable to convert [object Object] to payload`. On Temporal Cloud each workflow argument and each activity result is one payload, limited to 2 MB (`docs.temporal.io/cloud/limits`, read on 2026-10-26), so the node data of a large graph must fit in that either way.

Inside a Temporal workflow, `orchestrate` and the scheduler are workflow code: the dagraph bundled into the workers decides in which order the `RunNode` schedules its activities. So an integrator treats a dagraph upgrade, a patch release included, as a change to its workflow code, which Temporal requires to stay deterministic for every open workflow. A replay that meets another order of commands fails with `DeterminismViolationError`. What follows from Temporal's own docs (read on 2026-10-26: `docs.temporal.io/develop/typescript/versioning`, `docs.temporal.io/develop/typescript/testing-suite`, `docs.temporal.io/worker-versioning`; not run here, since it needs recorded histories):

1. **Pin dagraph to one exact version** in the project that bundles the workflows, with no range, so that no install changes it under open histories. `@mrmeku/dagworkflows` pins its `@mrmeku/dagraph` to its own version ([dagworkflows-cli-action-release](dagworkflows-cli-action-release.md)), which does nothing for a project that depends on dagraph directly.
2. **Replay before upgrading.** Download the histories of a representative set of recent open and closed workflows (`client.workflow.getHandle(id).fetchHistory()`, or the Temporal CLI), replay them under the new version with `Worker.runReplayHistories` (or `Worker.runReplayHistory` for one) from `@temporalio/worker`, and fail CI on any error. Temporal recommends this as a CI check for every change to workflow code.
3. **If a replay fails, or none was run, do not upgrade the workers in place** while workflows started under the old version are open. Either wait until none is open, or ship the upgrade under Worker Versioning with those workflows Pinned: a pinned workflow completes on the Worker Deployment Version it started on. Keep the old version's workers running while that version is Draining, that is until its pinned workflows have closed.

It refuses node data in which a node depends on a node it was not given, before anything runs, with the error `orchestrate: nodes depend on nodes it was not given: "a" needs "x"; "c" needs "y", "z"`. It refuses node data with a cycle the same way, naming the first cycle it finds, searching from each node in the order given and along each node's deps in theirs: `orchestrate: nodes depend on each other in a cycle: "a" needs "b" needs "c" needs "a"`. A node that depends on itself is a cycle, `"a" needs "a"`. A `Graph` cannot hold a cycle, so only node data built by hand or read from elsewhere can.

**The `RunNode` contract.**

- It must resolve to the node's `Result`. Orchestration hands the details of the nodes that succeed to their dependents and holds back the dependents of those that did not, from the status alone. A `RunNode` may return a result recorded earlier instead of running the node, as a replay does.
- If it rejects, the node settles `failed` with the rejection's name, message and JSON cause and no details, since nothing reported one; or `cancelled`, with no details, once the execution is cancelled.
- `waitForScheduler()` is what a node awaits before the work that needs its slot; `runNode` calls it on a miss, before the action runs. Orchestration does not know why a node asks. For a node with no concurrency group it resolves at once, with no event. For a grouped node the node pends: it returns its place to the scheduler and the promise resolves once the scheduler lets it run. It rejects once the execution is cancelled (at once if the cancel came first). Calling it twice returns the same promise. A `RunNode` that never calls it, such as one whose lookup hit, is never held back.

Where it lives: `packages/dagraph/src/orchestration/orchestrate.ts`, `orchestration/ports.ts`.

## `lookup-or-run/` (ports: the cache's `FileSystem`, orchestration's `Clock`, `StartTimer`, `ActionListener`)

`lookup-or-run/` does one node's work: it looks the node up in the cache, or runs its action and commits the outputs, or both, and turns its deps' cache entries into the handles the action reads. It takes the cache's `FileSystem` and orchestration's `Clock`, imported along its import edges, and its own `StartTimer` and `ActionListener`, declared in `lookup-or-run/ports.ts`. `ExecutionContext` hands it what fills them, with the cache directory, the forced keys and the actions' ports; `RunActionOptions` hands it the listener and the cancel. Its import edges are `orchestration/`, `graph/`, `cache/` and `json/`. Its `index.ts` exports the functions and types below, with `ActionEvent`, `ActionListener`, `StartTimer` and `fileHandle`; the package index publishes all but `fileHandle`.

Looking a node up and running it is two steps, and the scheduler's slot goes between them, since only a miss takes one:

- `lookupNode(graph, name, depEntries, executionContext)` computes the node's key and reads and verifies its entry. `depEntries` holds the `CacheEntry` of each dep that succeeded, by dep name. It resolves to a `Lookup`: a hit (`succeeded` with a `HitDetails`), `dep-failed` (a required dep missing from `depEntries`) or `failed` with no details (the key could not be computed), or a `Miss`, `{ name, actionKey, status: "missed" }`. A lookup never returns `actionRan: true`, and it runs nothing.
- `runAction(graph, miss, depEntries, executionContext, options?)` runs a missed node's action in a fresh attempt directory, commits its outputs and writes its entry. It resolves to a `NodeResult`: `succeeded` with `actionRan: true`, `failed` or `cancelled`, each failure or cancel with details carrying the key. Its options are `signal`, the execution's cancel, and `onEvent`, an `ActionListener` that receives the node's `start` and `output` before the result returns.
- `lookupOrRunNode(graph, name, depEntries, executionContext, options?)` is `lookupNode`, then `runAction` on a miss, with no slot to wait for: for a test, a script, or a worker whose executor already holds the node's slot.
- `runNode(graph, executionContext, options?)` is the `RunNode<Node<Meta>, SucceededNodeDetails, FailedNodeDetails, CancelledNodeDetails>` that waits for the scheduler between the two, as `execute` does. It turns the `depDetails` it is handed into `depEntries` by taking each details' `entry`.

`graph` must hold the node, but it need not be the graph the executor walks. Any graph that declares the node the same way gives it the same key, since a key depends only on the node's own kind, inputs and deps: the whole graph, a `closure` of it, or a graph rebuilt in a worker. If `graph` holds no node `name`, each rejects (it does not return a result) with: `the graph holds no node "<name>". Pass a graph that holds it: the whole graph, a closure of it, or any graph that declares the node the same way. A key is local to its node, so each gives it the same key.`

### Looking up and running nodes in another process

The split lets the executor run in one place and the work in another. The pattern:

1. The executor imports `orchestrate` from `@mrmeku/dagraph/orchestration`, which loads nothing of the cache, no hashing and no I/O module. It gets the node data (`graph.describe()`) and calls `orchestrate` with a `RunNode` that sends a request to a worker: the node's name, its deps' entries (each dep's details' `entry`), and whatever the worker needs to rebuild the graph.
2. To keep hits off the group's limit, the `RunNode` first asks a worker for a lookup only: `lookupNode`. A `missed` lookup is a miss; any other is the node's result.
3. On a miss, the `RunNode` awaits `waitForScheduler()` in the executor, then sends the node to a worker to run.
4. The worker rebuilds a graph that declares the node, and calls `lookupOrRunNode`, since the executor already holds the slot. It sends the `NodeResult` back as JSON; the executor can check it with `isNodeResult`.

Workers and executor must see the same cache at the same path: `depEntries` and results hold absolute paths into it ([dagraph-caching](dagraph-caching.md), "The cache directory layout"). Each key's entry is a manifest in it too, so one worker hits what another wrote. The executor reads no files and needs none of it. The `start` and `output` events happen in the worker; only `dispatch` and `result` reach the executor's listener. Each side stamps its own events with its own clock, so the stamps of one node come from two machines' clocks, and `elapsed` from the worker's.

For a worker to compute the key the executor's process would have, and to hit the entries other processes wrote:

1. **The same declaration.** The worker's graph must declare the node with the same `kind`, the same inputs (the action's own, including its `version`, and the node's) and the same roles. Names, meta, groups and timeouts may differ.
2. **The same files.** A `file()` input is keyed on its path as written and the bytes found there, read through the worker's own filesystem. A relative path is read from the worker's working directory.
3. **The same dep entries.** The worker keys on the content hashes in the `depEntries` it is given, and reads the dep files at the paths they hold.
4. **The same cache.** A worker hits the entries of any `cacheDir` that resolves to the directory they were written in, or to a copy of it ([dagraph-caching](dagraph-caching.md), "The cache directory layout").

Results cross back as JSON with nothing lost (see "A result is plain data"), and `isNodeResult` checks one read back. A replay passes a recorded result back from `RunNode` instead of calling a worker.

Where it lives: `packages/dagraph/src/lookup-or-run/lookup-or-run.ts` (`runNode` included), `lookup-or-run/handles.ts`, `lookup-or-run/ports.ts`, `orchestration/orchestrate.ts`.

## `json/` (no ports)

`json/` copies a value as JSON and tells JSON from what is not: `jsonCopy`, `isJsonValue`, `isPlainObject` and the type `JsonValue`. It imports no other component, and orchestration, graph and lookup-or-run have an import edge to it. Orchestration builds a failure's `cause` with `jsonCopy` and checks one read back with `isJsonValue` (see "A result is plain data"), and graph tells a plain record from a class instance with `isPlainObject` when it checks a value input ([dagraph-graphs](dagraph-graphs.md), "Inputs"). Only `JsonValue` is published, from the package index and the `./orchestration` entry.

Where it lives: `packages/dagraph/src/json/json.ts`, `json/index.ts`.

## Rules that always hold

- Every node given gets exactly one result, also on cancel, unless the scheduler returns early (see below) or throws.
- A node is never dispatched before all its deps have settled.
- A node that did not succeed leaves no cache entry. It leaves no attempt directory either, unless the cache write itself failed after its outputs were committed.
- `cancelled`, `failed` and `dep-failed` are never cached; the next execution retries them.
- A hit never starts, never emits `start`, never carries `elapsed`, and never takes a group slot.
- A scheduler only filters the ready order; it never reorders it.

## Open questions

1. **A synchronous throw from the listener on an `output` event fails the node.** The docs of `ActionListener` say only that an `output` promise's rejection is dropped. A listener that throws synchronously on `output` throws inside the action's `output(chunk)` call, so unless the action catches it, the node fails with the listener's error (verified: `{ name: "Error", message: "listener broke" }`). Intended?
2. **Sharing one `throttledScheduler` between executions that run at the same time: a rule or a bug?** The code does not say. Its counts (the places in use, and the slots in use per group) live in the closure of the `throttledScheduler(...)` call, so two executions running at once count each other's nodes, while each wakes only on its own events. Two failures follow. Verified under Bun 1.4.4 and Node 25.8.1, with two `orchestrate` calls of two nodes each, run at once over one scheduler, each node a 50 ms miss:
   - With `maxParallelism: 1`, the execution with nothing in progress spins on `workAvailable` (which resolves at once when nothing is being processed) and blocks the event loop: not even a 2 s watchdog timer fired, and the process stayed up until killed.
   - With only `concurrencyLimits: { heavy: 1 }` and grouped nodes, the event loop keeps running, but the second execution's misses never get the slot once the first execution frees it, because freeing it wakes only the first execution's loop. The first execution settles both its nodes; the second never resolves. Node then exits with code 13 and `Warning: Detected unsettled top-level await`; Bun stays up until killed.

   Reusing it for one execution after another works (checked by a separate run: three executions in turn over one scheduler with `maxParallelism: 1` and `heavy: 1`, every node's action ran). Nothing else speaks to either case: the doc comment of `throttledScheduler` does not mention reuse, no test reuses a scheduler at all, and every caller in this repository builds one per execution (dagworkflows' runner calls `throttledScheduler(opts.schedulerOptions)` once for the main pass and once for the post pass). If the shared counts are meant as one limit across executions, the missing wake-up across executions is a bug; if not, the rule is one `throttledScheduler(...)` per execution that may overlap another, and nothing enforces it. Which is intended?

3. **A scheduler that resolves before `hasWork()` is false** makes `execute` resolve early with only the results settled so far (verified: an empty array while a node was still running). Nothing refuses it.
4. **Duplicate node names** in `orchestrate`'s input are not refused; the results hold one entry for the name. A `Graph` refuses duplicates.
5. **A `RunNode` that resolves a result after the cancel** (a remote worker that never saw the signal) keeps that result: orchestration overrides only rejections with `cancelled`. Intended, presumably, but not pinned by a test.
6. **Stability of orchestration across versions.** Nothing in the code or tests pins the ready order or the sequence of `run` calls across dagraph releases, which a Temporal workflow history recorded under one version and replayed under another would need. The tests pin the order within one version only. Should a release that changes it be marked as breaking, so that integrators know when the replay and rollout steps under `orchestrate` matter? Until that is settled, they apply to every upgrade.
