# Execution

`execute` runs a graph in one process, to the end, and returns one result for each node:

```typescript
const results = await execute(
  graph,
  { ports, cache, fs, casBaseDir: ".dagraph" },
  { scheduler, onEvent },
);
```

It takes three arguments:

- **The graph.** See [Graphs](graphs.md).
- **The execution context.** It holds the actions' ports, the cache, the file system and the CAS directory. It outlives any one execution.
- **The options.** They control one execution: the scheduler, `onEvent`, `force` and the cancel `signal`.

One call of `execute`, or of [`orchestrate`](executors.md), over one graph is an execution. Cancelling and limits are each for one execution. `execute` also hashes each input file once per execution, however many nodes declare it. Under `orchestrate`, each call of `processNode` hashes the files that its node declares.

## The execution context

`ExecutionContext<Ports>` has these fields:

| Field        | Meaning                                                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ports`      | The actions' tools. The engine gives them to each action and each `invalidateOn` fingerprint, and never looks inside.                                                                                                                                                     |
| `cache`      | The cache. See [Caching](caching.md#caches).                                                                                                                                                                                                                              |
| `fs`         | The `DagFs` through which the engine does all its own I/O: hashing files, making, moving and removing directories, and reading [file handles](graphs.md#file-handles). Its `resolve` gives each path that an action sees: the absolute path in the Node and Bun adapters. |
| `casBaseDir` | The directory for the outputs of each node. See [Caching](caching.md#where-the-files-go).                                                                                                                                                                                 |

`execute` refuses, by type, ports that do not satisfy the graph's. A graph whose actions need no ports takes no `ports`. To run the same graph with stub, mock or real tools, change `ports`.

| `DagFs`               | Import from               | Use                                                                          |
| --------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `createNodeDagFs()`   | `@mrmeku/dagraph/fs/node` | Node.                                                                        |
| `createBunDagFs()`    | `@mrmeku/dagraph/fs`      | Bun. It streams large files through Bun's hasher.                            |
| `createMemoryDagFs()` | `@mrmeku/dagraph`         | Tests. It holds files in a `Map`, and its `resolve` returns a path as given. |

The file system adapters are subpath exports, not part of the package index. Thus the index imports no I/O module. See [Executors](executors.md#sandboxes).

To test one action, run a one-node graph under stub ports, `MemCache` and `createMemoryDagFs()`.

## Schedulers

A scheduler admits ready nodes. It takes them in the engine's order and only filters it: it can hold a node back, but it never reorders nodes. There are two:

| Scheduler                     | Behavior                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `unboundedScheduler()`        | Admits each node when it is ready. This is the default.                                                                   |
| `throttledScheduler(options)` | Processes at most `maxParallelism` nodes at once, and runs at most `concurrencyLimits[group]` actions of a group at once. |

A node joins a group with the `concurrencyGroup` of its action:

```typescript
const transcribe = defineAction<Ports, Params, string>({
  kind: "transcribe",
  inputs: { version: "whisper-v1" },
  concurrencyGroup: "whisper",
  action: async ({ depOutputs, ports, outputDir }) => {
    // ...
  },
});

await execute(graph, context, {
  scheduler: throttledScheduler({ maxParallelism: 8, concurrencyLimits: { whisper: 1 } }),
});
```

A group that is not in `concurrencyLimits` has no limit. A group of limit 1 runs its actions one at a time while other nodes run beside them, as Ninja's `console` pool does.

### A cache hit does not wait for its group

A node takes its group's slot only after its cache lookup misses. Thus a group limits how many of its actions run at once, and a hit never waits behind them.

- A node holds a `maxParallelism` place from when it is handed to processing until it settles. A hit holds one while its entry is verified.
- A miss in a group gives its place back while it waits for the group's slot, and takes a place and the slot again when both are free.
- Misses wait for their group in the engine's order.
- A cancel ends the wait. The node settles `cancelled`.

### The order of ready nodes

When more nodes are ready than can run, the engine takes them in this order:

1. The nodes that descend from the first root that you added.
2. Among those, the nodes that became ready most recently.

Thus the engine completes one branch before it starts the next. For example, it completes the pipeline of the first video before it starts more work on the second. Finished work arrives early, and fewer intermediate files wait on disk.

### Your own scheduler

A `Scheduler` is a function that gets a `SchedulerContext` and returns when the work is done. The context has four functions. A ready node is a `Ready`, `{ node, acquiring }`:

| Function          | What it does                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `take(filter?)`   | Returns the first `{ node, acquiring }` in the engine's order that the filter accepts, or `null`. A node comes once when it is ready, and again with `acquiring: true` when its lookup missed and it waits for its group's slot. |
| `run(ready)`      | Hands a ready node to processing, or gives an acquiring node its slot. The promise resolves when the node settles, or when it gives its place back to wait for a slot.                                                           |
| `hasWork()`       | Returns `true` while some nodes are not complete.                                                                                                                                                                                |
| `workAvailable()` | Resolves when a node settles or starts to wait for a slot, so that `take` can return something new.                                                                                                                              |

## Results

`execute` returns a `Result` for each node, in the order the nodes settled. Each holds the node's `name`, its `actionKey` (`""` when it never got one) and a `status`:

| Status       | Meaning                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `done`       | The action ran and succeeded. The result is the entry that it wrote, `outputs` and `contentHash`, with `elapsed`. |
| `cached`     | A cache hit. The result is the entry that it read.                                                                |
| `failed`     | The action failed. The result has `error: { name, message, cause? }` and `elapsed`.                               |
| `dep-failed` | A required dependency did not succeed, so the node did not run. `dep` names it.                                   |
| `cancelled`  | The execution was cancelled before the node completed.                                                            |

A node succeeded when its result is `done` or `cached`. Only a success has outputs. `done` tells that the action ran, not that its content changed. `tally(results)` counts the results by status, in a record keyed by the five statuses.

A result is plain data, except `error.cause`, which is the value that the action attached, as is.

## Events

`onEvent` gets one stream of events, in order, as they occur. Each event names its node and carries the node's `meta`:

| Event                                    | When                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `{ type: "dispatch", node, meta }`       | The node is handed to processing. Its cache entry is not read yet.   |
| `{ type: "start", node, meta }`          | The action starts. This is a cache miss: a cached node never starts. |
| `{ type: "output", node, meta, chunk }`  | The action printed `chunk` with its `output` function.               |
| `{ type: "result", node, meta, result }` | The node settled. `result` is its `Result`.                          |

A node's events come in that order: `dispatch`, `start`, its `output`, its `result`. A node that a failed dependency holds back has only a `result`. What an action prints after its result is dropped.

```typescript
const build = defineAction<Ports, Params, string>({
  kind: "build",
  inputs: { version: "build-v1" },
  action: async ({ output, outputDir }) => {
    output("compiling\n");
    // ...
  },
});

await execute(graph, context, {
  onEvent: (event) => {
    if (event.type === "output") process.stdout.write(`[${event.node}] ${event.chunk}`);
    if (event.type === "result" && event.result.status === "failed")
      console.error(event.node, event.result.error.message);
  },
});
```

With this stream you can make a progress view, a log file for each node or a live status, with no change to the actions. The engine renders nothing.

A `failed` result holds the error's `name`, its `message` and its `cause`. Thus a listener can tell why a node failed, for example a command's exit code, without reading the node's files.

## Timeouts and cancellation

An action gets an `AbortSignal` in its action context. The signal fires in two cases:

- The execution's `signal` is aborted.
- The node's `timeoutMs` elapses. The time starts when the action starts: waiting, hashing and the cache lookup do not count.

```typescript
const transcribe = defineAction<Ports, TranscribeParams, string>({
  kind: "transcribe",
  inputs: { version: "whisper-v1" },
  timeoutMs: 15 * 60_000,
  action: async ({ depOutputs, ports, outputDir, signal }) =>
    ports.whisper.transcribe(depOutputs.download.audio.path, outputDir, { signal }),
});
```

After the signal fires, the value that the action returns does not decide the result. This is the same as on the GitHub Actions runner: a process that traps the interrupt and exits with 0 did not finish its work. These rules apply:

- A node that the execution's signal stops is `cancelled`.
- A node whose own timeout fired is `failed` with an error named `TimeoutError`. The error keeps the `cause` of what the action threw when it stopped.
- If both fired, the result is `cancelled`.
- The engine caches neither result.
- Nodes that wait when the execution is cancelled become `cancelled` and do not start.

The engine never abandons a running action. Thus an action that ignores its signal holds its place until it returns. The results are complete either way.

The timeout is not part of the action key. To set a limit for the full execution, give a signal with a timeout:

```typescript
await execute(graph, context, { signal: AbortSignal.timeout(30 * 60_000) });
```
