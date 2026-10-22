# Executors

An executor decides where each node is processed. `execute` is the executor for one process. To process nodes elsewhere, use its two halves directly:

- `orchestrate` is the scheduling half. It tracks which nodes are ready, admits them through the scheduler, hands each node its dependencies' entries, and propagates failures. It works on nodes as data: it does no I/O, hashes nothing and never sees an action.
- `processNode` is the rest. It finds one node by name in a graph, calculates its key, reads and verifies its entry, and runs its action on a miss. It can run in any process.

`RunNode` joins them. `execute` is `orchestrate` with a `RunNode` that calls `processNode` in the same process, with the same graph and the same `onEvent`.

Each primitive means the same under every executor.

## orchestrate

```typescript
const results = await orchestrate(graph.describe(), runNode, scheduler, onEvent, signal);
```

| Argument    | Meaning                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `nodes`     | The nodes as data, from `graph.describe()`. A node whose dependency is not among them is refused, naming both. |
| `runNode`   | A `RunNode`: `(node, depEntries, acquire) => Promise<Result>`. See below.                                      |
| `scheduler` | The policy that admits ready nodes. See [Execution](execution.md#schedulers).                                  |
| `onEvent`   | Optional. Gets `dispatch` and `result`. See [Execution](execution.md#events).                                  |
| `signal`    | Optional. Cancels the execution: nothing new starts, and waiting nodes settle `cancelled`.                     |

`orchestrate` is deterministic within one version of the engine. A Temporal workflow history written by an earlier version need not replay.

## RunNode

For each node that the scheduler admits, `orchestrate` emits `dispatch` and calls `RunNode` with three arguments:

| Argument     | Meaning                                                                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node`       | The node as data.                                                                                                                                                                                                                                        |
| `depEntries` | The entry (`outputs`, `contentHash`) of each dependency that succeeded, by dependency name. A dependency missing from it did not succeed.                                                                                                                |
| `acquire`    | The gate of the node's concurrency group. Await it after a cache miss, before the action runs. The scheduler answers it once the group has a slot. It rejects only once the execution is cancelled, and `processNode` then settles the node `cancelled`. |

`RunNode` processes the node somewhere and returns its `Result`. If it rejects, the result is a failure, as when an action throws, or `cancelled` when the execution was cancelled.

A hit never calls `acquire`, so it never waits for its group. A node without a `concurrencyGroup` gets through `acquire` at once.

## processNode

```typescript
const result = await processNode(graph, name, depEntries, executionContext, options);
```

`processNode` finds the node `name` in `graph`. A name that the graph does not hold is refused. `options` holds these fields for this node:

| Option      | Meaning                                                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `force`     | Skip the entry read: run the node, then write its new entry.                                                                                                                                                                                             |
| `cacheOnly` | Look the node up without running it. A node without a verified entry fails with `NOT_CACHED` as its error's message. A `cacheable: false` node has no entry, so it fails too. With `force`, there is no lookup, so the node fails as not cached at once. |
| `signal`    | The execution's cancel. The node gets it through its action context.                                                                                                                                                                                     |
| `acquire`   | The gate that processing awaits after a miss, before the action runs.                                                                                                                                                                                    |
| `onEvent`   | Gets the node's `start` and `output` events, before its result returns.                                                                                                                                                                                  |

## Process nodes in other processes

Two things make the keys agree in each process:

1. **The same declaration.** In the process that processes a node, call the same function of your program's data that adds the nodes, and give the graph that it builds to `processNode`, with the process's own ports. A key is local to its node. Thus the graph can be the whole graph, a `closure` of it, or any smaller graph that holds the node.
2. **The same paths.** Each dependency's output files must be at the same paths in that process. Use a shared CAS directory, or copy the files to the same paths.

```typescript
// The coordinating process
const results = await orchestrate(
  buildGraph(videos).describe(),
  async (node, depEntries, acquire) => {
    const hit = await worker.run({ name: node.name, depEntries, cacheOnly: true });
    if (hit.status !== "failed" || hit.error.message !== NOT_CACHED) return hit;
    await acquire();
    return worker.run({ name: node.name, depEntries });
  },
  throttledScheduler({ concurrencyLimits: { whisper: 1 } }),
  onEvent,
);
```

```typescript
// The worker
const graph = buildGraph(videos);
return processNode(
  graph,
  request.name,
  request.depEntries,
  { ports, cache, fs, casBaseDir },
  {
    cacheOnly: request.cacheOnly ?? false,
  },
);
```

This `RunNode` looks each node up before it sends it to work, so a hit takes no slot on the worker either. These rules apply:

- `orchestrate` emits only `dispatch` and `result`. To get `start` and `output`, forward the worker's events into your own stream.
- A result is plain data, the `cause` of a failure included. Send it between processes as it is, and check what comes back with `isResult`.
- To replay a node, return its recorded `Result`. An executor that keeps results between processes keeps them as results.

## Choose for each node

`execute` takes `force` as `true` or `false`, for every node, and takes no `cacheOnly`. A choice for each node is an executor's. Its `RunNode` gives each node its own `force` or `cacheOnly`:

```typescript
const heal = (graph, context, degraded: Set<string>) =>
  orchestrate(
    graph.describe(),
    (node, depEntries, acquire) =>
      processNode(graph, node.name, depEntries, context, {
        force: degraded.has(node.name),
        acquire,
      }),
    throttledScheduler({ maxParallelism: 8 }),
  );
```

The dependents of a forced node run again only where its content changed.

## Sandboxes

The package index, `@mrmeku/dagraph`, imports no I/O module (`node:*` or `bun`). Thus code that runs in a sandbox with no I/O, for example a Temporal workflow, can import it, build a graph and call `orchestrate`. The file system adapters are in the subpaths `@mrmeku/dagraph/fs` and `@mrmeku/dagraph/fs/node`, and the Mermaid helper in `@mrmeku/dagraph/mermaid`. Import them only where you need them.

A lint rule of the repository keeps this true: outside its file system adapters, no file of the package imports an I/O module or an adapter.
