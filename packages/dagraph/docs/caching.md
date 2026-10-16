# Caching

The engine does not run a node when the cache has a correct result for it. To find that result, it calculates the node's action key from everything that decides the node's output. If the cache has an entry for the key, and the entry's files are not changed, the node does not run.

## The action key

The action key is a SHA-256 hash of these items:

- the node's name,
- the node's config,
- the content hash of each dependency's outputs,
- the content hash of each file in `inputs`.

The engine sorts the dependencies and the inputs before it hashes them. Thus their order does not change the key.

The keys form a Merkle tree. A change to a node's input changes its key, and the keys of all nodes downstream of it.

### Change the config when the logic changes

The config is the only part of the key that tells about the action's logic. If you change what an action does, for example a filter or a prompt, change its config:

```typescript
const transcode = defineAction<Ctx, Params, string>({
  config: { version: 2, bitrate: "128k" },
  action: (ctx, config) => async (params, inputs, outputDir) => {
    // ...
  },
});
```

If you do not change the config, the engine continues to use the results of the old logic.

A config change invalidates each result of that action. If only some results are incorrect, use `force` for these nodes. See [Run again or inspect](#run-again-or-inspect).

### Early cutoff

When a node runs again, the engine hashes its new outputs. If the content hash is the same as before, the action keys of its dependents do not change. Thus they come from the cache.

## Output verification

Before the engine uses a cache entry, it hashes the entry's files again. If a file is missing, or its hash is different, the engine runs the node again.

## Where the files go

Each node writes its outputs to `<casBaseDir>/<action key>/out`. `outputDirFor(casBaseDir, actionKey)` returns this path.

`FsCache` writes its entry to `<baseDir>/<action key>/manifest.json`. You can give `FsCache` the same directory as `casBaseDir`. The output directory and the manifest do not collide.

## Caches

A cache has two functions: `get(key)` and `put(key, entry)`. An entry holds the output paths and their content hash.

| Cache         | Behavior                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `MemCache`    | Holds entries in memory. They go away when the process ends. Use it in tests.                                     |
| `FsCache`     | Holds entries as JSON files on disk. They stay between runs.                                                      |
| `TieredCache` | Reads the local cache first, then the remote cache. A remote hit is copied to the local cache. It writes to both. |

To use your own storage, implement the `Cache` interface.

> [!NOTE]
> An entry holds file paths, not file content. The files must be at these paths when the entry is read. A remote cache is useful only when the CAS is shared too, or when its files are restored to the same paths.

## Run a node each time

`cacheable: false` stops the engine from reading or writing the cache for a node. The node runs in each execution. Use it for work that is not deterministic, for example an integration test.

The engine still hashes the node's outputs. Thus its dependents still use the cache by content.

## Read part of a dependency

The action key includes the full content hash of each dependency. If a node reads only part of a dependency's outputs, give a fingerprint of that part with `normalize`. The engine hashes the fingerprint into the key, in place of the content hash:

```typescript
const summarize = defineAction<Ctx, SummarizeParams, string>({
  config: "summarize-v1",
  normalize: (ctx) => ({ fetch: async (out) => (await ctx.readJson(out.meta)).description }),
  action: (ctx) => async (_params, inputs, outputDir) =>
    summarizeDescription(ctx, inputs.fetch.meta, outputDir),
});
```

While the description does not change, `summarize` comes from the cache, also when other fields of `meta` change.

A fingerprint that includes all that the action reads is as correct as the content hash. A fingerprint that leaves out something on purpose is a trade-off. For example, a transcript can be keyed on the identity and length of a video, but not on its encoding. Make that trade-off in `normalize`, where the action declares it.

A constant fingerprint, `() => ""`, makes a node wait for a dependency but keeps that dependency out of the key.

## Run again or inspect

`execute` has two options for one execution. Each is `true`, `false`, or a function that selects nodes:

| Option      | Effect                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `force`     | The selected nodes run, also when they are in the cache. Their dependents run again only if the outputs changed.                        |
| `cacheOnly` | The selected nodes do not run. A node without a correct cache entry fails with the error `NOT_CACHED`, and its dependents fail with it. |

Use `cacheOnly` with a function that leaves out your check nodes. The execution then runs only the checks, and it reports the state of the cache without any other work.

## What is never cached

The engine does not cache these results:

- a failure,
- a node that timed out,
- a node that was cancelled,
- a node with `cacheable: false`.
