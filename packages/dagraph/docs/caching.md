# Caching

The engine does not run a node when the cache has a correct result for it. To find that result, it calculates the node's action key from what the node declares. If the cache has an entry for the key, and the entry's files are not changed, the node does not run.

## The action key

The action key is a SHA-256 hash of these items, each under the name or the role that the action reads it by:

- each input, the action's and the node's own, by name: a file's path and the hash of its content, or a value as JSON with sorted keys, each [output ref](graphs.md#output-refs) as its role and output name;
- each dependency, by role: the content hash of its outputs; or, under `invalidateOn`, the hash of its fingerprint; or, for a settled dependency that did not succeed, a mark for missing.

A node's content hash covers each output's name, each file's path relative to its output directory, and each file's content. The names and paths are in it because a dependent reads paths: an output's name decides which file the dependent reads. These rules follow:

- The hash does not change when the output directory moves.
- The hash changes when two outputs swap their files.
- Renaming an output, or the file that it names, runs the dependents again, even when the bytes are the same.

The engine sorts the inputs by name and the dependencies by role. Thus their order does not change the key.

Nothing else is part of the key: not the node's name or the names of its dependencies, not the action's `kind` or its function, not `meta`, not `cacheable`, `concurrencyGroup` or `timeoutMs`. Thus renaming a node changes no key, and swapping two dependencies between roles does.

The keys form a Merkle tree. A change to an input changes the key of the node, and the keys of all nodes downstream of it, until [early cutoff](#early-cutoff) stops it.

### Change a version input when the logic changes

The function is not part of the key. If you change what an action does, for example a filter or a prompt, change a value input that stands for its logic:

```typescript
const transcode = defineActionWithPorts({
  kind: "transcode",
  deps: { source: fetch },
  inputs: { version: "transcode-v2", bitrate: "128k" },
  action: async ({ inputs, depOutputs, ports, outputDir }) => {
    // ...
  },
});
```

If you do not change it, the engine continues to use the results of the old logic.

A version change invalidates each result of that action. If only some results are incorrect, run those nodes again with `force` from an executor. See [Executors](executors.md#choose-for-each-node).

### Nodes that share a key

Caching is content-addressed. Two nodes that declare the same inputs and the same dependency content have one key and share one entry, whatever their names. When one has run, the other gets its result. This is correct for deterministic work, and it is the reason that a value that tells two nodes apart must be an input.

One key can occur twice in one execution. Each node is processed as any other: one whose key has a verified entry gets it, and one whose key has none runs. When two such nodes miss together, both run:

- Deterministic work makes the same files, and the two attempts publish one directory.
- Nondeterministic work can make different files. Attempts of one key that run at the same time both keep their directories, and the later entry replaces the earlier one in the cache. Neither attempt removes the other's directory, so no dependent loses a file. The key's next attempt removes all the earlier directories.

The engine does not process a key only once in each execution.

### Early cutoff

When a node runs again, the engine hashes its new outputs. If the content hash is the same as before (the same outputs, naming files at the same paths with the same bytes), the keys of its dependents do not change. Thus they come from the cache. A node with no outputs always has the same content hash, the hash of zero files.

## Output verification

Before the engine uses a cache entry, it hashes the entry's files again. If a file is missing, or its hash is different, the entry is a miss and the node runs again.

## Where the files go

Each attempt of a node writes its outputs to an empty directory of its own, `<casBaseDir>/<action key>/tmp-<uuid>`. When the action succeeds, the engine renames it to `<casBaseDir>/<action key>/out-<content hash>` and rewrites the returned paths to match. Nothing writes that directory again, so two executions that share a CAS never change a file the other reads. At worst, both do the work and the later entry wins.

- The action sees the output directory as an absolute path. A returned path under it can be absolute or relative to the working directory. The engine compares paths in their normal form, so a path made with `path.join` matches. A returned path that is not under the output directory fails the node.
- The entry and the result hold each path in the form of `casBaseDir`. Thus under a relative `casBaseDir`, they hold relative paths, and a CAS directory restored under another working directory still hits. A key built from a handle's absolute `path`, in a fingerprint or in an output's content, would make it miss.
- When an attempt publishes, the engine removes the key's published directories that existed before the attempt's action ran, and keeps its own. Thus attempts of one key that run at the same time both keep their directories, and the key's next attempt removes all the earlier ones. No attempt removes the files of an attempt that runs beside it.
- An attempt that does not succeed has its directory removed. An attempt that is killed outright leaves its `tmp-<uuid>` directory.

`FsCache` writes its entry to `<baseDir>/<action key>/manifest.json`. You can give `FsCache` the same directory as `casBaseDir`. The output directory and the manifest do not collide.

## Caches

A cache has two functions: `get(key)` and `put(key, entry)`. An entry, a `CacheEntry`, holds the output paths and their content hash. An entry that cannot be read or parsed is a miss, never a failure, and so is a `get` that fails.

| Cache         | Behavior                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| `MemCache`    | Holds entries in memory. They go away when the process ends. Use it in tests.                                     |
| `FsCache`     | Holds entries as JSON files on disk. They stay between runs.                                                      |
| `TieredCache` | Reads the local cache first, then the remote cache. A remote hit is copied to the local cache. It writes to both. |

To use your own storage, implement the `Cache` interface.

> [!NOTE]
> An entry holds file paths, not file content. It is valid wherever its files are at these paths from the working directory. A remote cache shares results only if it also carries the files to the same paths, or the CAS directory is shared.

## Run a node each time

`cacheable: false` stops the engine from reading or writing the cache for a node. The node runs in each execution. Use it for work that is not deterministic, or for state that no key can see, such as a tool's own state.

The engine still calculates the node's key and hashes its outputs. Thus its dependents still use the cache by content.

## Read part of a dependency

The action key includes the full content hash of each dependency. If the nodes of an action read only part of a dependency's outputs, give a fingerprint of that part with `invalidateOn`, by role. The engine hashes the fingerprint into the key, in place of the content hash:

```typescript
const summarize = defineActionWithPorts({
  kind: "summarize",
  deps: { fetch },
  inputs: { version: "summarize-v1" },
  invalidateOn: {
    fetch: async (outputs) => (await outputs.meta.json(isMeta)).description,
  },
  action: async ({ depOutputs, ports, outputDir }) => {
    const { description } = await depOutputs.fetch.meta.json(isMeta);
    const out = `${outputDir}/summary.txt`;
    await ports.writeFile(out, await ports.summarize(description));
    return out;
  },
});
```

The fingerprint holds what the action reads: the description. While it does not change, `summarize` comes from the cache, also when other fields of `meta` change. A fingerprint runs where the node is processed, with the execution's ports, and only for a dependency that succeeded.

A fingerprint that includes all that the action reads is as correct as the content hash. A fingerprint that leaves out something on purpose is a trade-off. For example, a transcript can be keyed on the identity and length of a video, but not on its encoding. Make that trade-off in `invalidateOn`, where the action declares it.

A constant fingerprint, `() => ""`, makes a node wait for a dependency but keeps that dependency out of the key.

## Run again

`execute`'s `force` option is `true` or `false`. `true` runs every node of the execution, also when it is in the cache, and writes the new entries. `execute` refuses a `force` that is not `true` or `false`, and a `cacheOnly` option.

To force some nodes and not others, or to look nodes up without running them (`cacheOnly`), use an executor that chooses for each node. See [Executors](executors.md#choose-for-each-node). The dependents of a forced node run again only if its outputs changed.

## What is never cached

The engine does not cache these results:

- a failure,
- a node that timed out,
- a node that was cancelled,
- a node with `cacheable: false`.
