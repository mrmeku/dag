# dagraph: caching

## The problem

A dagraph graph is a set of nodes, each one use of an action (a unit of work) with inputs and deps (other nodes whose output files it reads). Building graphs is covered in [dagraph-graphs](dagraph-graphs.md). Scheduling, events, cancellation and timeouts are covered in [dagraph-execution](dagraph-execution.md). This page covers what makes a second run cheap.

Some actions are slow or cost money: a download, a long computation, a model call. Running the same graph again should rerun only the nodes whose work would come out differently. It should also never hand back a stale or damaged file as if it were fresh. dagraph does this with content addressing:

- every node gets an **action key**, a hash of what defines its work;
- every successful run stores a **cache entry** under that key: the output paths and a hash of their contents;
- the output files live in the **cache**, a directory tree named by those hashes.

Core idea: a node's key is built from its action's kind, its inputs and the content hashes of its deps. If a stored entry exists for that key and its files are unchanged, by the size and mtime they were committed with or else by their hash, the node is a **hit** (it succeeds with `details.actionRan: false`) and its action does not run. Otherwise it is a **miss**: the action runs in a fresh private directory, its files are made read-only, the directory is committed into the cache, and the entry is written. Dependents key on content, not on keys, so a node that reruns and produces the same bytes stops the change from spreading further. This is **early cutoff**.

## Terms

- **Action key** (`actionKey` on a `NodeResult`'s details, which `resultActionKey` finds on any status): a 64-character lowercase SHA-256 hex string. It names the node's work and its directory in the cache. A result has none when the node never got one: a required dep did not succeed, the key could not be computed, or the execution was cancelled before the node was dispatched. Graph computes it ([dagraph-graphs](dagraph-graphs.md), "The action key: exactly what is hashed").
- **Cache entry** (type `CacheEntry`): `{ outputs, contentHash, outputHashes }`. `outputs` holds the files the action returned, in the record it returned: each value a path or a list of paths. `contentHash` is the hash of those files, and `outputHashes` holds each output's own hash, by name (see below). A result that succeeded carries its entry as `details.entry`.
- **Content hash**: a SHA-256 hex string over each output's name, each file's path relative to its output directory, and each file's bytes.
- **Cache directory** (`cacheDir` in the execution context): the root of the cache. Its `v1/` holds a directory per key, with the key's entry as `manifest.json` and each entry's files in a **content directory** named by its content hash; its `tmp/` holds what is not committed yet. The engine reads and writes all of it through the context's `fs`, which fills the cache's `FileSystem` port: usually the local disk (`createNodeFileSystem`, `createBunFileSystem`), but possibly memory (`createMemoryFileSystem`).
- **Last use**: the mtime a prune judges by ("Pruning"). A hit sets its manifest's, and a commit its content directory's, to the context's `clock` time, best effort: a stamp that fails changes no result.
- **`FileSystem`**: the cache's port, the filesystem the engine does all its file I/O through ("The cache's `FileSystem` port").

## `cache/` (port: `FileSystem`)

`cache/` hashes outputs and owns the entries, the layout of the cache directory, commits and pruning, under a key it is given and never computes. It reads no clock: lookup-or-run hands it the time, read from the context's `clock`, for each last use it stamps, and tells a commit whether to write the key's manifest, which it does unless the node is `cacheable: false`. Its port is `FileSystem` ("The cache's `FileSystem` port"), declared in `cache/ports.ts` with `Stats`, the part of `lstat`'s result it reads, and `isMissingFileError`, which tells a read that failed for want of a file. Its one import edge is `graph/`, for `Outputs` and the walks over their paths, and for `HashFile`, which `FileSystem.hashFile` is. Its `index.ts` exports `lookupEntry`, `commitEntry`, `newStagingDir`, `discard`, `pruneCache`, `isCacheEntry`, `hashBytes`, `isMissingFileError` and the types `CacheEntry`, `PruneOptions`, `FileSystem` and `Stats`, for lookup-or-run and the filesystems; the package publishes `pruneCache`, `CacheEntry`, `PruneOptions` and `FileSystem`. The sections from here to "Finding out why a node reran" describe it and how lookup-or-run uses it.

Where it lives: `packages/dagraph/src/cache/index.ts`, `packages/dagraph/src/cache/cache.ts`, `packages/dagraph/src/cache/content-addressing.ts`, `packages/dagraph/src/cache/ports.ts`.

## Where caching sits in looking a node up and running it

When lookup-or-run looks a node up and runs it ([dagraph-execution](dagraph-execution.md)), these steps happen in this order. `execute` calls it only for the nodes that `orchestrate` dispatches: a node whose required dep failed is settled `dep-failed` by `orchestrate` before dispatch, and a node still waiting when the execution is cancelled is settled `cancelled` the same way. Neither gets a key, and neither reaches the steps below.

`lookupNode` takes the first three steps and `runAction` the last two. `lookupOrRunNode` runs both, and `runNode`, the `RunNode` that `execute` uses, waits for the scheduler between them ([dagraph-execution](dagraph-execution.md)).

1. **Required deps.** `lookupNode` repeats the check for executors that call it directly. If a required dep (any dep not marked `settled`) has no entry in the `depEntries` it was given, the node settles `dep-failed` with `dep` set to that dep's name and no key. Nothing is hashed.
2. **Key.** The engine hashes every file input, then builds the key ([dagraph-graphs](dagraph-graphs.md), "The action key: exactly what is hashed"). If a file cannot be read, the node settles `failed` with no details, so no key. The message is the file system's, such as `ENOENT: /missing.ts`.
3. **Lookup.** This step is skipped when the node is `cacheable: false` or its key is forced. The engine reads the key's `manifest.json`. One that is missing, cannot be read, is not JSON, or is not `{ outputs, contentHash, outputHashes }` with outputs that are a record and hashes that are strings, or has no `fileStats` of sizes and mtimes, counts as a miss and is not an error. If an entry exists, the engine checks the files it names in its content directory (this is **verification**, see "Output verification"). If they are unchanged, the engine stamps the manifest's last use and the node settles `succeeded` with a hit's details, `{ actionKey, entry, actionRan: false }`, the entry its paths absolute, as `lookupEntry` returned it. A hit has no `elapsed` and emits no `start` event. Otherwise the lookup is a miss, `{ name, actionKey, status: "missed" }`, which is not a result: it is what `runAction` runs.
4. **Run.** The engine creates a staging directory, `<cacheDir>/tmp/<uuid>`, emits `start`, and calls the action with `outputDir` set to its absolute form. If the directory cannot be created, or a `start` listener's promise rejects, the node fails with that error and details with its key and no `elapsed`, and the action never runs.
5. **Commit.** The engine checks that the returned paths are under `outputDir` and name regular files, records each file's size and mtime and makes it read-only, hashes them relative to it, renames the directory to the content directory `<cacheDir>/v1/<actionKey>/<contentHash>`, stamps that directory's last use, and writes the entry with those sizes and mtimes. This last write is skipped for `cacheable: false`. The node settles `succeeded` with `{ actionKey, entry, actionRan: true, elapsed }`, the entry its paths absolute, as `commitEntry` returned it.

When the action throws, times out, is cancelled, misses an output, returns a path outside `outputDir` or one that is not a regular file, or the staging directory cannot be renamed into place (see "A damaged content directory"), the staging directory is removed and no entry is written. When the entry write fails, the node fails too, but its outputs are already committed to their content directory and are not removed.

Where it lives: `packages/dagraph/src/lookup-or-run/lookup-or-run.ts`, `packages/dagraph/src/cache/cache.ts`, `packages/dagraph/src/orchestration/orchestrate.ts`, `packages/dagraph/src/execute.ts`.

## The action key

The key is graph's: [dagraph-graphs](dagraph-graphs.md), "The action key: exactly what is hashed", says exactly what joins it and what never does. In short, it hashes the action's kind, its inputs by name, a `file()` input with its content hash, and each dep role with the hashes of the outputs it reads, and nothing else: not the node's name, its meta, the action function or how it runs. The cache never computes a key: it stores and finds entries under the key lookup-or-run gives it.

Where it lives: `packages/dagraph/src/graph/action-key.ts`.

## Version inputs

The action's code is not in its key, so editing an action's logic does not invalidate anything by itself. The convention is a value input in the action's own `inputs`, such as `inputs: { version: 1 }`, bumped whenever the logic changes. The bump gives every node of the action a new key. Dependents rerun only if the new output differs (early cutoff). dagraph treats `version` as an ordinary input. The name has no special meaning to it.

Rolling an input back to an earlier value hits that value's earlier entry, unless a prune removed it. A test pins this on a chain `fetch -> parse -> summarize` in which only `summarize` carries the `version` input: run with `version: "v2"` (3 ran), then `"v3"` (1 ran, 2 hit), then `"v2"` again (0 ran, 3 hit).

## Keys across dagraph versions

The key holds no dagraph version, format tag or salt: only the kind, the inputs and the deps, as above. So a dagraph release that builds keys and content hashes the same way gives every node the same key, and upgrading to it reruns nothing unless it changes the cache's on-disk format ("The cache directory layout"). Both constructions count: dependents key on the content hash, and a hit that hashes compares it. A hit whose sizes and mtimes match compares nothing, so a release that changes how content hashes are built must also bump `CACHE_FORMAT_VERSION`, or its stat-matched hits keep handing dependents the old hashes. A test pins two keys as literal hex strings (in `dag.test.ts`, "a ref from the inputs function keys as the same ref written from its node did"), so a change to how those two are built fails the tests. No other test of dagraph pins a literal key or content hash.

The construction has changed once already. The latest version on npm, `@mrmeku/dagraph` `0.3.0` (`latest`, published 2026-10-16, checked with `npm view` on 2026-10-26), builds its key differently. It feeds into one SHA-256, in order, the node's name, a `config` string, each dep's node name and content hash (sorted by name), and each input file's path and hash. Its content hash is the SHA-256 of the number of output files followed by their hashes, sorted by path, with no names or relative paths. This was read from `src/content-addressing.js` in the published tarball. The current code keys the kind, the inputs and the roles instead, so no key that `0.3.0` computed matches one it computes. Upgrading from `0.3.0` to a release of the current code therefore reruns every node once. The entries `0.3.0` wrote are never read again, and their directories stay, since a prune removes only from `v1/` and `tmp/`.

Outputs then became a record only. An action that returned a record keeps its content hash, so its dependents keep their keys. One that returned a bare path or a list now returns a record, which hashes differently, so its dependents rerun once. Its own key does not change, but the entry it wrote holds a bare path or a list, which the lookup no longer reads as an entry: it misses and the node runs once (pinned in `dag.test.ts`). Then `invalidateOn` was removed, and a role came to key on the hashes of the outputs it reads instead of its dep's content hash. Every node with a dep gets a new key, and an entry without `outputHashes` is no longer read as an entry, so every node runs once. Whether a later release may change the construction again is not settled (see Open questions).

Where it lives: `packages/dagraph/src/graph/action-key.ts`, `packages/dagraph/src/cache/content-addressing.ts`, `packages/dagraph/src/dag.test.ts`.

## Content hash and early cutoff

The content hash is the SHA-256 hex of a JSON shape built from the returned outputs: `[[name, [[rel, hash], ...]], ...]`, sorted by output name. Each value is treated as a list, in list order, so a path `p` and the list `[p]` hash the same.

`rel` is the file's path relative to the attempt's directory. A test pins the consequences: the same files under another key's directory or another attempt's directory give the same content hash. Swapping which file each output names, renaming the file, renaming the output, or editing the bytes does change it. Check, verified by running: one output `{ greeting: "hello.txt" }` holding `hi` has content hash `sha256(JSON.stringify([["greeting", [["hello.txt", sha256("hi")]]]]))`.

Dependents key on the hashes of the outputs they read (each output's hash is built the same way from its own part of the shape, `sha256(JSON.stringify([[rel, hash], ...]))`), never on the dep's action key. Early cutoff follows from that. Suppose node `a` gets a new key (say a version bump) and reruns, but writes the same bytes to the same file names. Its content hash is unchanged, so `b`, which depends on `a`, keeps its key and is a hit, and so does everything below it. Here is the pinned example for a chain `a -> b -> c` (ran: the action ran; hit: found in the cache):

| Run | Change                    | a   | b   | c     |
| --- | ------------------------- | --- | --- | ----- |
| 1   | first run                 | ran | ran | ran   |
| 2   | `a` version 2, same bytes | ran | hit | hit   |
| 3   | `a` version 3, new bytes  | ran | ran | hit\* |

\* In the test, `b`'s output does not depend on what `a` wrote, so `b` reruns to the same bytes and `c` is cut off one level down.

Since each dependent keys on its dep's content hash, and that dep keyed on its own deps' content hashes, the keys form a chain from the roots down, like a Merkle tree: a change anywhere reaches exactly the nodes below it whose inputs really changed, and stops at the first node that reproduces its bytes.

**A node with no outputs always cuts off.** An action may return `{}` (a node run for its effect, such as a notification). Its content hash is then `sha256("[]")` on every run, so a rerun of it never re-keys its dependents. Verified: a `notify` node returning `{}` with input `n: 1`, then `n: 2`, runs both times with content hash `4f53cda1…`, and its dependent runs, then hits. A dependent that must rerun whenever such a node reruns needs the node to write a file that changes, such as a receipt holding what it did.

### Quick start: three runs (verified under Bun 1.4.4 and Node 22.18, 23.6, 24.0, 24.22 and 25)

A two-node graph: `count` counts the words of its input, `report` writes a sentence from the count.

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startGlobalTimer,
  wallClock,
  defineAction,
  execute,
  Graph,
  nodeInputs,
} from "@mrmeku/dagraph";
import { createNodeFileSystem } from "@mrmeku/dagraph/fs/node";

const count = defineAction({
  kind: "count",
  inputs: { version: 1 },
  nodeInputs: nodeInputs<{ text: string }>,
  action: async ({ inputs, outputDir }) => {
    const words = join(outputDir, "count.txt");
    await writeFile(words, String(inputs.text.split(/\s+/).length));
    return { words };
  },
});
const report = defineAction({
  kind: "report",
  deps: { count },
  action: async ({ depOutputs, outputDir }) => {
    const sentence = join(outputDir, "report.txt");
    await writeFile(sentence, `${await depOutputs.count.words.text()} words`);
    return { sentence };
  },
});

const cacheDir = join(await mkdtemp(join(tmpdir(), "quick-")), "cache");
const fs = createNodeFileSystem();
const context = { fs, cacheDir, clock: wallClock, startTimer: startGlobalTimer };
async function run(text: string) {
  const graph = new Graph();
  report.addNode(graph, { deps: { count: count.addNode(graph, { inputs: { text } }) } });
  for (const r of await execute(graph, context))
    console.log(
      r.name,
      r.status === "succeeded" ? (r.details.actionRan ? "ran" : "hit") : r.status,
    );
}
await run("hello big world");
await run("hello big world");
await run("goodbye small world");
```

Save it as `quick.ts` and run `bun quick.ts`, or `node quick.ts`. It was run against the package as `scripts/pack.ts` packs it for a release, under Bun 1.4.4 and Node 22.18.0, 23.6.0, 24.0.0, 24.22.1 and 25.8.1. Plain `node` runs a `.ts` file only on a Node that strips types by default. Node's TypeScript documentation (`https://nodejs.org/api/typescript.html`, whose history was read on 2026-10-26) turns stripping on by default in 22.18.0 and 23.6.0, and every release from 24.0 on has it. So `node quick.ts` runs on 22.18 and the later 22 releases, on 23.6 and the later 23 releases, and on every 24, 25 and 26 release. No single "or later" bound says this, because 23.0 to 23.5 are newer than 22.18 by number and refuse the file. Node 22.6 to 22.17 and 23.0 to 23.5 refuse `quick.ts` with `ERR_UNKNOWN_FILE_EXTENSION` (`Unknown file extension ".ts"`), before dagraph is loaded, and run it with `--experimental-strip-types` (both verified on 22.17.0 and 23.5.0). Node before 22.6, every 20 and older release included, has no type stripping: the same documentation gives 22.6.0 as the version that introduced it. Before the output, `ExperimentalWarning: Type Stripping is an experimental feature and might change at any time` is printed by every 23 release from 23.6 and by 24.0 to 24.2, since the documentation drops that warning in 22.18.0 and 24.3.0. Verified: 23.6.0 and 24.0.0 print it, and 22.18.0, 24.22.1 and 25.8.1 do not. With no `package.json`, Node 25 runs it silently. With a `package.json` that has no `type` field, which is what `npm install` writes, each of those Node versions first prints a `MODULE_TYPELESS_PACKAGE_JSON` warning; `npm pkg set type=module` stops it. Apart from that, it prints exactly:

```
count ran
report ran
count hit
report hit
count ran
report hit
```

The first run runs both. The second finds both keys in the cache. The third changes `count`'s input, so `count` gets a new key and runs; it writes `3` again, its content hash is unchanged, so `report` keeps its key and is a hit: early cutoff.

Where it lives: `packages/dagraph/src/cache/content-addressing.ts`.

## Output verification

A hit is a stat check. The engine `lstat`s each file the entry names and compares its `size` and `mtimeMs` with what the manifest's `fileStats` records for it. When every file matches, no output is hashed. When one differs or is gone, the engine re-hashes every file the entry names and compares the result to `contentHash`: a match is a hit, and anything else (a file deleted or changed, or one that fails to read) is a miss and the node reruns. So a file changed in place that kept its size and mtime is served as a hit; forcing its key is the way to distrust it.

Two mtimes less than a millisecond apart match: a copy that keeps timestamps, such as dagworkflows' worktree cache store, keeps them only to the millisecond, since `fs.cp` with `preserveTimestamps` truncates them under Bun and rounds them under Node.

**A damaged content directory.** Say `<actionKey>/<contentHash>/` was made writable and edited in place. The lookup misses, and the rerun usually produces the original content, so the same content hash. The rename onto that directory fails because it exists and is not empty. The engine then checks the copy there as a commit checks its own files, and hashes them. A copy that passes (another attempt committed the same content first) is kept, the staging directory removed, and the manifest records the copy's sizes and mtimes, so its hits stay stat checks. A damaged one is moved into `tmp/`, the staging directory is renamed in its place, and the damaged copy is removed (pinned by a test). A commit tries the rename five times, since attempts of one key racing over a damaged copy may each move away what another put there. Then, as when the rename fails for any other reason (permissions, a cross-device move), the node fails with the rename's own error.

**Missing outputs.** A returned path with no file fails the node, and the failure is never cached. The message is ``output "<name>" (<file>) was not written. Write it at `${outputDir}/<file>` before the action returns.``, where `<name>` is the output's name and `<file>` the returned path relative to the attempt's output directory. For example: `output "thumb" (audio.jpg) was not written. Write it at \`${outputDir}/audio.jpg\` before the action returns.` (`${outputDir}`appears literally in the message.)

**Outputs are regular files.** A returned path that is a directory or a symbolic link fails the node with `output "<name>" (<file>) is not a regular file. Return files only, never a directory or a symbolic link.`, since a link could lead out of the entry. Each path is checked before its mode changes, so the file a link leads to is left as it was. A path that cannot be looked at for another reason keeps its own error: one under a file fails with `ENOTDIR` on the Bun and Node filesystems.

**Read-only outputs.** A commit makes each returned file read-only, as `chmod a-w` does: the write bits go and the others stay. It then flushes the file to disk with `fsync`, before recording its stats, so a crash cannot leave a file whose stats match the manifest but whose data was lost. A write to a committed file then fails with `EACCES`, so nothing rewrites a cache entry in place, nor a file hard-linked to one, which is the same file. Removing or renaming one still works, since that takes its directory's write permission.

**Outputs outside the directory.** A returned path, absolute or relative (a relative path is resolved against the working directory), that does not resolve under `outputDir` fails with `output not under the output dir: <path> is not under <outputDir>`. `../sibling` and `/elsewhere` are both refused.

Where it lives: `packages/dagraph/src/cache/content-addressing.ts`, `packages/dagraph/src/cache/cache.ts`.

## The cache directory layout

    <cacheDir>/
      v1/                       the on-disk format: a new format gets a new directory
        <actionKey>/
          manifest.json         the entry, its paths relative to its content directory
          <contentHash>/        the entry's files, read-only, never written again
      tmp/
        <uuid>/                 an attempt in progress, or a directory being removed
        <uuid>.json             an entry being written (left behind if its rename fails)

Rules that always hold:

- **Each attempt gets a fresh, empty, private directory.** `outputDir` is the absolute path of `tmp/<uuid>/`, and only that attempt writes to it. Two concurrent runs of the same node therefore never touch each other's files. A test pins that a concurrent run rewriting its own output never corrupts another run's dependent.
- **A successful attempt is renamed to `v1/<actionKey>/<contentHash>/`.** If another attempt already committed the same content there and that copy still verifies, it is reused and the new attempt's directory is deleted; a damaged copy is replaced (see "A damaged content directory"). Outputs keep their path relative to the directory: `tmp/X/a/b.txt` becomes `<contentHash>/a/b.txt`.
- **A failed, timed-out or cancelled attempt's directory is removed**, best effort. A process killed mid-action leaves its `tmp/<uuid>/` behind until a prune removes it. Likewise a `tmp/<uuid>.json` whose rename failed, or whose process was killed, stays.
- **Only a prune removes a content directory that verifies.** Older content directories of a key stay after a newer attempt commits. A forced rerun to different content adds another content directory and repoints the manifest. `cacheable: false` nodes commit a new content directory on every run whose content differs, and they never have a manifest.
- **An output named `manifest.json` is fine.** It lives inside `<contentHash>/`, not beside the entry.
- **An entry is written whole.** The engine writes `tmp/<uuid>.json`, then renames it over the key's `manifest.json`, so a concurrent lookup finds the whole last entry or the whole new one, never half of either (pinned by a test).
- **Paths.** The action always sees absolute paths, in `outputDir` and in file handles' `.path`. The manifest holds each path relative to its content directory, normalized, whichever form the action returned. Each process resolves `cacheDir` with its `FileSystem`' `resolve` when it looks an entry up or commits one, so results and `depEntries` hold absolute paths, into the cache where that process found it. So a relative `cacheDir`, its other spellings (`cache`, `./cache`, `cache/`) and the absolute directory it resolves to are one cache, and a cache copied or restored to another directory hits there, its results naming the copy's files (pinned by a test). A relative `cacheDir` that resolves to another directory, under another working directory, is another cache.

Example manifest (written with two-space indentation):

    {
      "outputs": { "page": "page.json" },
      "contentHash": "bf27...",
      "fileStats": { "page.json": { "size": 17, "mtimeMs": 1793208241958.45 } }
    }

Where it lives: `packages/dagraph/src/lookup-or-run/lookup-or-run.ts`, `packages/dagraph/src/cache/cache.ts`.

## Pruning

`pruneCache(fs, cacheDir, { unusedSince })`, from the package index, removes what no run used since `unusedSince`, a time in ms since the epoch such as a run's start, and resolves to the paths it removed, absolute and sorted. It reads no clock, and the engine never calls it. It removes:

- a key directory whose newest last use, of its manifest and its content directories, is before `unusedSince`: a commit that has placed new content but not yet written its manifest keeps its key;
- in a key directory that stays, each content directory that its manifest does not name and that was last used before `unusedSince`;
- each entry of `tmp/` whose mtime is before `unusedSince`, such as a killed attempt's directory.

A key or content directory is renamed into `tmp/` before it is removed, so a lookup finds it whole or gone. A file beside the key directories, such as a Finder `.DS_Store`, is left alone. A prune is not locked against a run on the same cache: a run that uses a directory the prune read as unused, as it removes it, loses those files, and its node, or the prune, can fail.

Where it lives: `packages/dagraph/src/cache/cache.ts`.

## Nodes that share a key

The key depends only on kind, inputs and dep content. So two nodes declared the same way share one key, one directory in the cache and one entry, even under different names, in different graphs, or with different `meta`, timeouts or groups. A test pins this: node `a` in one graph runs, then a node named `v:b` in another graph, with the same kind and inputs but a different group and timeout, is a hit with `a`'s output.

For the same reason `lookupNode`, `runAction` and `lookupOrRunNode` can be given any graph that declares the node the same way; [dagraph-execution](dagraph-execution.md) covers its graph argument and the error when the node is missing.

Within one execution, nodes that share a key are **not** deduplicated. If both miss, both run, each in its own `tmp/<uuid>/`:

- With identical content, both commit to the same content directory. The second finds the first's copy, verifies it, uses it and drops its own. Both results name the same files.
- With different content (a nondeterministic action), each commits its own content directory and both results' files exist. The manifest names whichever wrote last.

Tests that need nodes to stay apart give each node a distinguishing input, such as its name as an `id`.

## Reading part of a dependency

A role keys on the outputs it reads, as Bazel keys an action on the files it takes from a target. By default it reads all of its dep's outputs. `pick` narrows it: `deps: { download: pick(download, "thumb") }` keys the node on `thumb`'s hash alone, so a new `audio` from the same dep reruns nothing, and the action's `depOutputs.download` holds `thumb` only, in its type and at run time. `settled(pick(…))` and `maybe(pick(…))` keep the pick, and `pick(dep<T>(), …)` narrows a role that more than one action fills. A test pins it: a dep rebuilt with a new `extra` and the same `main` leaves a required, a settled and a maybe role that pick `main` all hits, and a new `main` reruns them.

A node that reads only part of one file, such as a few fields of a JSON file, still keys on the whole file. Two things bound that. Early cutoff: a node that writes the same bytes when its part is unchanged keeps its hashes, so its own dependents stay hits. And a projection: a cheap node that reads the file and writes the part as outputs of its own, which consumers pick. It reruns on any change to the file, and writes the same bytes when the part is unchanged, so its consumers stay hits.

An action whose work is too costly to repeat can also skip it itself: it keeps its results in a store of its own, outside the cache, named by what it reads, and links a stored result back on a run whose part is unchanged.

Where it lives: `packages/dagraph/src/lookup-or-run/lookup-or-run.ts`, `packages/dagraph/src/graph/action-key.ts`, `packages/dagraph/src/graph/types.ts` (`pick`).

## Running a node each time: `cacheable: false`

An action defined with `cacheable: false` has an entry that is never read or written, so its node runs in every execution. `describe()` shows `cacheable: false` on the node. The node still:

- gets a key and a key directory;
- runs in a private `tmp/<uuid>/`;
- commits to its content directory, `<contentHash>/`;
- reports a content hash.

Its dependents key on that content hash, so they cache normally. For example, a probe that always writes the same bytes runs every time while the report built from it stays a hit. Its lookup is always a miss. `cacheable` is not in the key. Changing an action from `false` to `true` finds an entry only if one was written before the flag was set to `false`.

## Running again and forcing

- **Plain rerun.** Every node whose key and files are unchanged is a hit. Failures are never cached. A rerun after a partial failure therefore resumes: succeeded nodes hit, and the failed node and the nodes it held back run. A test pins `a` a hit and `b`, `c`, `d` run, with `start` events only for b, c and d.
- **Forcing.** The execution context's `forcedKeys` is `"all"` or a `ReadonlySet<string>` of action keys. The lookup of every key, or of each key in the set, misses, so those nodes run though their entries are good, and each writes its new entry, which the next plain run hits:

      await execute(graph, { ...ctx, forcedKeys: "all" });

  With a set, only the nodes of those keys run, for example the keys of results you saved (a result is plain JSON; `resultActionKey` reads its key). The dependents of a forced node are not forced. They key on its new content, so they rerun only if that changed.

- **Looking up without running.** `lookupNode` computes the key and checks the entry, and runs nothing: with a verified entry the node is a hit, otherwise its lookup is a miss.

## What is never cached

These fail or stop without writing an entry, and their attempt directory is removed:

- a node whose action threw;
- a node that timed out (`timedOut: true`, `error.name` is `"TimeoutError"`, message `timed out after <ms> ms`), whatever its action returned;
- a node that was cancelled, whatever its action returned;
- a node with a missing output, an output outside its directory, or one that is not a regular file;
- a node whose output ref names an output its dep did not produce (`"<node>" has no output "<output>"`);
- a node whose attempt directory could not be created, or renamed into its content directory;
- a node whose `start` event listener rejected (it fails with the listener's message and never runs).

These never write an entry and never create an attempt directory: a node whose key could not be computed, a `dep-failed` node, and a miss that was never run.

A `cacheable: false` node never writes an entry either, but a successful run commits and keeps its content directory. A node whose entry write rejected also keeps its content directory (see above).

Tests pin that a failed node fails again on the next run, rather than being served from a stale entry. A timed-out node also keeps failing until it finishes in time. `timeoutMs` is not in the key, so changing the timeout of a node that succeeded earlier still hits.

## Finding out why a node reran

dagraph keeps only the key, never what went into it. A result carries `actionKey` in its details. The `start` event carries no key. The entry holds only `outputs` and `contentHash`. `describe()` lists neither a node's inputs nor its roles. The code that builds the key is not exported, and the package's `exports` map refuses a deep import of it: `ERR_PACKAGE_PATH_NOT_EXPORTED` under Node, `ERR_MODULE_NOT_FOUND` under Bun. No option prints the key's parts. What a reader can do:

1. **Compare the node's `actionKey` across the two executions.** A result is plain JSON, so save each execution's results to compare later. If the key is the same and the node's action ran the second time, the key did not cause the rerun. The node was forced, is `cacheable: false`, had no entry (an earlier run failed, or the cache directory is a different one), or its entry failed verification (a file was deleted or edited). `<cacheDir>/v1/<actionKey>/manifest.json` shows whether the entry exists and which files it names. If the key differs, one of its parts changed, or the dagraph version did (see "Keys across dagraph versions").
2. **Compare the parts the reader can see.** The kind and the inputs come from the reader's own code. A role is the `outputHashes` of the outputs it reads, on that dep's result. A file input is its path as given plus the SHA-256 of its bytes.
3. **Rebuild the whole preimage and diff it.** Built by hand from [dagraph-graphs](dagraph-graphs.md), "The action key: exactly what is hashed", the preimage reproduces the engine's key exactly. `canonical` is `JSON.stringify` of the value with object keys sorted at every level, so a string `"v1"` keys as `"\"v1\""` and `1` as `"1"`. Inputs and roles are sorted with the default `sort()`. The hash is the SHA-256 hex of `JSON.stringify(preimage)`, the same from `node:crypto` (`createHash("sha256").update(text).digest("hex")`) as from `js-sha256`. Print one preimage per execution and diff the two to name the part that changed.

Verified under Bun and Node 25, against the `actionKey` of an executed node. The node is a `summarize` action with inputs `version: "v1"` and `options: { b: 1, a: [true, null] }`, a node input `config: file(<path>)`, and a role `source`. Its preimage is:

    ["summarize",
     [["config", ["file", "<path as given>", "<sha256 of its bytes>"]],
      ["options", ["value", "{\"a\":[true,null],\"b\":1}"]],
      ["version", ["value", "\"v1\""]]],
     [["source", ["outputs", [["<output name>", "<that output's hash>"]]]]]]

An output ref inside a value input appears in its `canonical` string as `#ref(<JSON of [roles, outputName]>)`.

Where it lives: `packages/dagraph/src/graph/action-key.ts`, `packages/dagraph/src/graph/inputs.ts`, `packages/dagraph/src/index.ts`, `packages/dagraph/package.json` (`exports`).

## The cache's `FileSystem` port

`FileSystem` is every filesystem operation the engine performs: hashing, the cache and its entries, and file handles. The cache declares it, and lookup-or-run imports it to hand its files to the cache's functions and to read file handles through. Each member is a plain function, and the engine calls each one detached (`fs.hashFile(path)`), so an implementation must not use `this`. The members:

| Member                     | Takes               | Gives                                                                                                                                                                                      |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `readText(path)`           | a path              | the file's text                                                                                                                                                                            |
| `writeText(path, content)` | a path and a string | writes the file, creating missing parent directories in all three implementations                                                                                                          |
| `hashFile(path)`           | a path              | the SHA-256 hex of the bytes. Its type is graph's `HashFile`, so `FileSystem` fills that port for the key's `file()` inputs.                                                               |
| `ensureDir(path)`          | a path              | makes the directory, with its parents                                                                                                                                                      |
| `rename(from, to)`         | two paths           | POSIX rename: replaces a file at `to` atomically; fails when `to` is a non-empty directory. A commit relies on this.                                                                       |
| `remove(path)`             | a path              | deletes a file, or a directory recursively; does nothing if it is absent                                                                                                                   |
| `lstat(path)`              | a path              | `isFile()`, `mode`, `size` and `mtimeMs` of the path itself, not a link's target; rejects with code `"ENOENT"` when nothing is there, which the engine uses to name an output not written. |
| `chmod(path, mode)`        | a path and a mode   | POSIX chmod: sets the file's permission bits. A commit makes each output read-only with it.                                                                                                |
| `fsync(path)`              | a path              | POSIX fsync: flushes the file's data to disk. A commit flushes each output before recording its stats.                                                                                     |
| `utimes(path, …)`          | a path, two `Date`s | POSIX utimes: sets the access and modification times of a file or a directory. A hit and a commit stamp a last use with it.                                                                |
| `readdir(dir)`             | a directory         | entry names; `[]` if the directory is absent                                                                                                                                               |
| `resolve(path)`            | a path              | the absolute form, as an action sees it                                                                                                                                                    |

The execution context passed to `execute`, `lookupNode`, `runAction` and `lookupOrRunNode` is `ExecutionContext`: `{ fs, cacheDir, clock, startTimer, forcedKeys?, ports? }` ([dagraph-execution](dagraph-execution.md)). Its `fs` is a `FileSystem`. `ports` is required exactly when the graph's actions need ports. The engine passes them through untouched. The action context (`ActionContext`: `inputs`, `depOutputs`, `ports`, `outputDir`, `signal`, `output`) holds no file system, so an action writes its files any way it chooses: directly with `node:fs`, as the quick start does, or through a port, as the complete example below does. The engine then reads, hashes and moves them through the context's `fs`. The tests put the same `FileSystem` in both places.

Where it lives: `packages/dagraph/src/cache/ports.ts` (`FileSystem`, `Stats`, `isMissingFileError`), `packages/dagraph/src/graph/ports.ts` (`HashFile`), `packages/dagraph/src/lookup-or-run/lookup-or-run.ts` (`ExecutionContext`).

## `filesystem/` (no ports: its adapters fill the cache's `FileSystem` port)

`filesystem/` holds the two adapters that fill the cache's `FileSystem` port from a real disk, and the in-memory double for tests. Its one import edge is `cache/`, for `FileSystem`, `isMissingFileError` and `hashBytes`. Its `index.ts` exports the memory adapter only, and the package index re-exports it; the disk adapters are reached only through the `./fs` and `./fs/node` subpaths. `FileSystem` has no `exists`, and none of the three implements one: a caller that wants to know whether something is at a path calls `lstat`, which rejects with code `ENOENT` when nothing is.

Three implementations:

- **`createNodeFileSystem()`**, from the `@mrmeku/dagraph/fs/node` entry point. Built on `node:fs/promises`. `writeText` creates missing parent directories with `mkdir -p`. `hashFile` streams the file through `node:crypto`.
- **`createBunFileSystem()`**, from the `@mrmeku/dagraph/fs` entry point. Built on `Bun.file`, `Bun.write` and `Bun.CryptoHasher`, so it needs the Bun runtime. `Bun.write` creates missing parent directories. Hashing streams the file.
- **`createMemoryFileSystem(initial?)`** and its type `MemoryFileSystem`, from the package index. Files live in a `Map` exposed as `.files`, from path to `{ data, mode, mtimeMs }`, so a test can seed or inspect it. Two paths that hold one such object are hard links to one file, and a write changes the object, so every link sees it. `initial` is a record of path to string or bytes, each a file of mode `0o644`, and `writeFile(path, data)` writes either, as `writeText` writes text. Hashing a string hashes its UTF-8 bytes, and `lstat`'s `size` counts them. A write to a file whose mode has no owner write bit fails with code `EACCES`, as on disk, and each write gives its file an mtime a millisecond later than any before. It differs from a real disk in these ways:
  - only files exist: a directory is just the files under its prefix, which `readdir`, `rename`, `remove`, `lstat` and `utimes` see. A directory's mtime is the one `utimes` last gave it, or else 0. There are no symbolic links;
  - `lstat`'s `mode` holds the permission bits alone, without the file type's;
  - `ensureDir` does nothing;
  - `resolve` returns the path unchanged;
  - `rename` moves a file or every file under a directory. It throws `ENOENT: <from>` if nothing is there. When the source is a directory, it throws `ENOTEMPTY: <to>` if the target holds files. When the source is a file, it never checks the target, so renaming a file onto a non-empty directory succeeds and leaves a file and a directory sharing one name, which POSIX refuses.

Why the two real ones are separate entry points: they import `node:fs`, and only `filesystem/` may import an I/O module, so the package index, which re-exports the memory adapter alone, loads none. Import the index for the engine and the memory filesystem; import `/fs` or `/fs/node` for disk.

A file handle (what an action receives for a file input or a dep output) reads through the same `FileSystem`; lookup-or-run makes it. Its `text()` refuses a file whose bytes are not valid UTF-8, with `<abs> is not UTF-8 text: decoding it lost bytes. Hash its bytes with hash().`. A file that genuinely contains U+FFFD reads normally.

Where it lives: `packages/dagraph/src/filesystem/node.ts`, `packages/dagraph/src/filesystem/bun.ts`, `packages/dagraph/src/filesystem/memory.ts`, `packages/dagraph/src/filesystem/index.ts`, `packages/dagraph/src/lookup-or-run/handles.ts`, `packages/dagraph/package.json` (`exports`).

## A complete example (runs with Node's filesystem; verified)

    import { Graph, actionsFor, startGlobalTimer, wallClock, execute, type FileSystem } from "@mrmeku/dagraph";
    import { createNodeFileSystem } from "@mrmeku/dagraph/fs/node";

    type Ports = { fs: FileSystem };
    const defineActionWithPorts = actionsFor<Ports>();
    const fetchPage = defineActionWithPorts({
      kind: "fetch",
      inputs: { version: 1 },
      action: async (c) => {
        const page = `${c.outputDir}/page.json`;
        await c.ports.fs.writeText(page, JSON.stringify({ title: "Hello" }));
        return { page };
      },
    });
    const title = defineActionWithPorts({
      kind: "title",
      inputs: { version: 1 },
      deps: { fetchPage },
      action: async (c) => {
        const title = `${c.outputDir}/title.txt`;
        await c.ports.fs.writeText(title, JSON.parse(await c.depOutputs.fetchPage.page.text()).title);
        return { title };
      },
    });
    const build = () => {
      const g = new Graph<Ports>();
      title.addNode(g, { deps: { fetchPage: fetchPage.addNode(g, {}) } });
      return g;
    };
    const fs = createNodeFileSystem();
    const ctx = { ports: { fs }, fs, cacheDir: "cache", clock: wallClock, startTimer: startGlobalTimer };
    await execute(build(), ctx); // fetch: ran, title: ran
    await execute(build(), ctx); // fetch: hit, title: hit

After this, `cache/v1/` holds one directory per key, and `cache/tmp/` nothing. Each key's directory holds `manifest.json` and one `<contentHash>/` with `page.json` or `title.txt` in it. The result of `fetch` looks like `{ name: "fetch", status: "succeeded", details: { actionKey: "<64 hex>", entry: { outputs: { page: "<working directory>/cache/v1/<key>/<hash>/page.json" }, contentHash: "<64 hex>", outputHashes: { page: "<64 hex>" } }, actionRan: true, elapsed: 2 } }`.

## Open questions

1. **A failed entry write fails the node, but an entry that cannot be read is only a miss.** The outputs were already committed when the write fails, and they stay. Is a failed entry write meant to fail the node?
2. **Nothing bounds the cache's size.** A prune removes by last use alone. Is a size bound wanted?
3. **No stated policy on key stability across releases.** The key carries no format version, and only two literal keys are pinned by a test. Nothing in the code or the release scripts says whether a release may change how keys or content hashes are built, or whether such a change needs a new major version. The change since `0.3.0` reruns every node once. Is every such change meant to be called out in a release?
4. **Nothing records a key's parts.** Explaining a rerun means rebuilding the preimage by hand, because no result, event or entry holds it and the code that builds it is not exported. Is that intended, or should the engine expose the preimage, for example on a result or an event?
