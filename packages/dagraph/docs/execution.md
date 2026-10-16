# Execution

`execute` runs a graph to the end and returns one result for each node:

```typescript
const results = await execute(graph, { cache, fs, casBaseDir: ".dagraph" }, { scheduler, onEvent });
```

It takes three arguments:

- **The graph.** See [Graphs](graphs.md).
- **The execution context.** It holds the cache, the file system and the CAS directory. It usually stays the same between runs.
- **The options.** They control one run: the scheduler, the callbacks, `force`, `cacheOnly` and the cancel signal.

## The execution context

| Field         | Meaning                                                                             |
| ------------- | ----------------------------------------------------------------------------------- |
| `cache`       | The cache. See [Caching](caching.md#caches).                                        |
| `fs`          | The file system that the engine uses to hash files and make directories. A `DagFs`. |
| `casBaseDir`  | The directory for the outputs of each node.                                         |
| `inputHashes` | Optional. A memo of input hashes. `execute` makes one for each run.                 |

The engine uses `DagFs` only for its own work. Your actions use their own context for their files.

| `DagFs`               | Import from               | Use                                               |
| --------------------- | ------------------------- | ------------------------------------------------- |
| `createNodeDagFs()`   | `@mrmeku/dagraph/fs/node` | Node.                                             |
| `createBunDagFs()`    | `@mrmeku/dagraph/fs`      | Bun. It streams large files through Bun's hasher. |
| `createMemoryDagFs()` | `@mrmeku/dagraph`         | Tests. It holds files in a `Map`.                 |

The file system adapters are subpath exports, not part of the package index. Thus the index imports no I/O module. See [Runners](runners.md#sandboxes).

## Schedulers

A scheduler decides how many nodes run at the same time. There are two:

| Scheduler                     | Behavior                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `unboundedScheduler()`        | Runs each node when it is ready. This is the default.                                         |
| `throttledScheduler(options)` | Runs at most `maxParallelism` nodes, and at most `concurrencyLimits[group]` nodes of a group. |

A node joins a group with the `concurrencyGroup` of its action:

```typescript
const transcribe = defineAction<Ctx, Params, string>({
  config: "whisper-v1",
  concurrencyGroup: "whisper",
  action: (ctx) => async (params, inputs, outputDir) => {
    // ...
  },
});

await execute(graph, context, {
  scheduler: throttledScheduler({ maxParallelism: 8, concurrencyLimits: { whisper: 1 } }),
});
```

A node in a group that is not in `concurrencyLimits` has no group limit.

### The order of ready nodes

When more nodes are ready than can run, the engine takes them in this order:

1. The nodes that descend from the first root that you added.
2. Among those, the nodes that became ready most recently.

Thus the engine completes one branch before it starts the next. For example, it completes the pipeline of the first video before it starts more work on the second. Finished work arrives early, and fewer intermediate files wait on disk.

### Your own scheduler

A `Scheduler` is a function that gets a scheduler context and returns when the work is done. The context has four functions:

| Function          | What it does                                                    |
| ----------------- | --------------------------------------------------------------- |
| `take(filter?)`   | Returns the next ready node that the filter accepts, or `null`. |
| `run(node)`       | Runs the node. The promise resolves when the node is complete.  |
| `hasWork()`       | Returns `true` while some nodes are not complete.               |
| `workAvailable()` | Resolves when a node completes, so that new nodes can be ready. |

## Results

`execute` returns an `ExecResult` for each node. `status` is one of these values:

| Status       | Meaning                                                                          |
| ------------ | -------------------------------------------------------------------------------- |
| `done`       | The action ran and succeeded. The result has the outputs and their content hash. |
| `cached`     | The result came from the cache. It has the same fields as `done`.                |
| `fail`       | The action failed. The result has the error.                                     |
| `dep-failed` | A required dependency failed, so the node did not run.                           |
| `cancelled`  | The execution was cancelled before the node completed.                           |

`tally(results)` counts the results by status.

When a node fails, each node that needs it gets `dep-failed`. The engine does not run them.

## Events and output

`onEvent` gets each change of state as it occurs. `onOutput` gets the text that each action prints:

| Event        | When                                                                                 |
| ------------ | ------------------------------------------------------------------------------------ |
| `dispatch`   | The scheduler gave the node to a runner. The cache is not checked yet.               |
| `start`      | The action starts. This is a cache miss. A cached node never starts.                 |
| `cached`     | The result came from the cache.                                                      |
| `done`       | The action succeeded.                                                                |
| `fail`       | The action failed. `error` has the message and the `cause` of what the action threw. |
| `dep-failed` | A required dependency failed.                                                        |
| `cancelled`  | The execution was cancelled. `actionKey` is `""` if the node did not start.          |
| `settled`    | The node is complete. This event comes after each of the five results above.         |

An action prints with the `output` function of its action context. The engine gives each piece of text to `onOutput`, with the node:

```typescript
const build = defineAction<Ctx, Params, string>({
  config: "v1",
  action:
    (ctx) =>
    async (params, inputs, outputDir, { output } = {}) => {
      output?.("compiling\n");
      // ...
    },
});
```

With these two callbacks you can make a progress view, a log file for each node or a live status, with no change to the actions.

The `fail` event holds the message and the `cause` of the error that the action threw. Thus a listener can tell why a node failed, for example a command's exit code, without reading the node's files.

## Timeouts and cancellation

An action gets an `AbortSignal` in its action context. The signal fires in two cases:

- The execution's `signal` is aborted.
- The node's `timeoutMs` elapses. The time starts when the action starts.

```typescript
const transcribe = defineAction<Ctx, TranscribeParams, string>({
  config: "whisper-v1",
  timeoutMs: 15 * 60_000,
  action:
    (ctx) =>
    async (_params, inputs, outputDir, { signal } = {}) =>
      ctx.whisper.transcribe(inputs.download.audio, outputDir, { signal }),
});
```

After the signal fires, the value that the action returns does not decide the result. This is the same as on the GitHub Actions runner: a process that traps the interrupt and exits with 0 did not finish its work. These rules apply:

- A node that the execution's signal stops is `cancelled`.
- A node whose own timeout fired fails with an error named `TimeoutError`. The error keeps the `cause` of what the action threw when it stopped.
- If both fired, the result is `cancelled`.
- The engine caches neither result.
- Nodes that wait when the execution is cancelled become `cancelled` and do not start.

The engine never abandons a running action. Thus an action that ignores its signal holds its place until it returns.

The timeout is not part of the action key. To set a limit for the full execution, give a signal with a timeout:

```typescript
await execute(graph, context, { signal: AbortSignal.timeout(30 * 60_000) });
```
