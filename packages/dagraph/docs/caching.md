# When a node runs again

A node is `cached` when the cache holds a verified entry for its action key. Otherwise its action runs. The [quick start](../README.md#quick-start) shows both over three executions. This page says what the key holds, how to steer it, and what to check when a node reran, or did not, against your expectations. Every export it names is in the [API reference](api/index.md).

## What the key holds

A node's **action key** is a SHA-256 hash of what defines its work. When the action succeeds, its **cache entry** records the files it returned and their **content hash**, a hash of the outputs and their bytes. The files live in the **CAS**, a content-addressed store under the execution context's `casBaseDir`.

In the quick start, `count`'s key holds its kind, its own input `version: 1` and its node input `text`. `report`'s key holds its kind and, under the role `count`, the content hash of what `count` wrote. In full, the key joins:

- the action's `kind`;
- each input by name, from the action's own inputs and the node's together ([how to declare each](graphs.md#inputs)): a value input as JSON, and a `file(path)` as its path and the file's bytes;
- each dependency by role: its content hash, or the hash of its [fingerprint](#key-on-part-of-a-dependency) where `invalidateOn` gives one for the role.

Nothing else joins it. Not the node's name or its `meta`. Not the action's function. Not the working directory or the machine. And not anything the action reads without declaring it, such as a file at a path it builds itself, an environment variable or a network call.

So renaming a node leaves the key alone. Two nodes declared the same way share one key and one entry, even in different graphs. A lookup re-hashes an entry's files before it counts as a hit, so a node whose outputs were changed or deleted runs again.

## Make a logic change rerun

The action's function is not in its key, so editing it reruns nothing by itself. Give the action a version input, such as `inputs: { version: 1 }`, and bump it whenever the logic changes. Every node of the action then gets a new key. Its dependents rerun only if its new output differs, by [early cutoff](../README.md#how-it-works).

## Key on part of a dependency

By default a dependent reruns whenever any byte of a dependency changes. If it reads only part of one, declare `invalidateOn: { <role>: (outputs, ports) => string | Promise<string> }` on the action. The string it returns is the **fingerprint**, and its hash replaces that role's content hash in the key. `outputs` are the dependency's outputs as file handles, which you read with `text()`, `json(guard)` or `hash()`.

A summary that reads only the page id inside its fetched source declares `invalidateOn: { source: async (source) => idOf(await source.text()) }`, where `idOf` is your own function that reads the id. It stays `cached` when the source is fetched again with different bytes but the same page id. It runs again when the id changes.

## Run a node every time

An action defined with `cacheable: false` never reads or writes its entry, so its nodes run in every execution. Their dependents still key on their content hash and cache as usual. So a probe that writes the same bytes each time runs every time, while the report built from it stays `cached`.

## Force a run

To run nodes whose entries are good, wrap the cache with `forcedCache`. Its reads miss and its writes go through, so the next plain execution hits the new entries. Against the `graph` and `context` of the [Run a graph](execution.md#execute-a-graph) example:

```ts
import { execute, forcedCache } from "@mrmeku/dagraph";

await execute(graph, { ...context, cache: forcedCache(context.cache) });
```

`forcedCache(cache, keys)` forces only the nodes of those keys, such as the `actionKey`s of results you saved. A forced node's dependents key on its new content, so they rerun only if that content changed.

## What is never cached

A node writes no entry when its action throws, times out or is cancelled, or when a required dependency failed and it settled `dep-failed`. The next execution tries it again. So an execution after a partial failure resumes: the nodes that succeeded are `cached`, and the failed node and the nodes it held back run.

## If a node reran, or did not

A result is plain JSON, so save each execution's results and compare the node's `actionKey` in the two. Then find the symptom below.

- **It ran again with a new key.** Something in the key changed. Compare each dependency's `contentHash` in the two saved results. If they all match, the change is in the node itself: its `kind`, an input's value or a `file()`'s bytes. A dependency that writes different bytes on every run, such as a timestamp, reruns its dependents every time. Make its output deterministic, or key on the part that matters with `invalidateOn`.
- **It ran again with the same key.** It was forced, its action is `cacheable: false`, or one of its outputs was changed or deleted on disk.
- **It did not rerun after you changed its code.** The function is not in the key. Bump its version input.
- **It did not rerun after a file, an environment variable or a remote service changed.** The action read it without declaring it. Declare a `file()` input, a value input, or a dependency on a node that fetches it.
- **A dependent stayed `cached` when its dependency ran.** That is early cutoff: the dependency wrote the same bytes, or gave the same fingerprint.
- **A new node was `cached` the first time it ran.** Another node with the same kind, inputs and dependency content already stored that entry, perhaps in another graph. To keep two nodes apart, give each a distinguishing input, such as its name as an `id`.
