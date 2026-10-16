# Runners

`execute` schedules the nodes and runs them in the same process. To run nodes in other processes, use its two parts directly:

- `orchestrate` schedules the nodes. It stays in one process.
- `processNode` runs one node: it checks the cache, runs the action and stores the result. It can run in any process.

`execute` is `orchestrate` with a `RunNode` function that calls `processNode` in the same process.

## Run nodes in other processes

1. Build the graph in the coordinating process. Give `orchestrate` the result of `graph.describe()`. Each `Node` holds only data, so you can send it to other processes.
2. Write a `RunNode` function. `orchestrate` calls it for each ready node, with the content hashes and the outputs of the node's dependencies. Send these values to a worker.
3. In the worker, build the same graph with the worker's own context. Find the node by name in `graph.getNodes()`, and give it to `processNode`.
4. Return the `ProcessNodeResult` from the worker to `RunNode`.

```typescript
const results = await orchestrate(
  graph.describe(),
  (node, depContentHashes, depOutputs, started) =>
    worker.run({ name: node.name, depContentHashes: [...depContentHashes], depOutputs }),
  throttledScheduler({ maxParallelism: 16 }),
  onEvent,
);
```

```typescript
// In the worker
const node = buildGraph(workerContext).getNodes().get(request.name)!;
return processNode(node, new Map(request.depContentHashes), request.depOutputs, executionContext);
```

These rules apply:

- The worker must build the same graph. Node names and configs must be the same in each process, or the action keys are different.
- Each dependency's output files must be at the same paths in the worker. Use a shared CAS directory, or copy the files to the same paths.
- `started` emits the `start` event. A worker that cannot call back can ignore it. The node then has no `start` event.
- A failed result can hold the `cause` of the error. Serialize the cause, or remove it, when you send the result between processes. If `RunNode` rejects in place of a `fail` result, the result has no cause.

## Register the action functions

`action.createAction(ctx)` returns an action's function without a graph. Use it when a worker framework needs each function registered before it runs, for example as an activity.

## Sandboxes

The package index, `@mrmeku/dagraph`, imports no I/O module (`node:*` or `bun`). Thus code that runs in a sandbox with no I/O, for example a Temporal workflow, can import it, build a graph and call `orchestrate`. The file system adapters are in the subpaths `@mrmeku/dagraph/fs` and `@mrmeku/dagraph/fs/node`. Import them only where the nodes run.

The test `sandbox-safe.test.ts` keeps this true.
