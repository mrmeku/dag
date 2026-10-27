# dagraph: caching

## The problem

A dagraph graph is a set of nodes, each one use of an action (a unit of work) with inputs and deps (other nodes whose output files it reads). Building graphs is covered in [dagraph-graphs](dagraph-graphs.md). Scheduling, events, cancellation and timeouts are covered in [dagraph-execution](dagraph-execution.md). This page covers what makes a second run cheap.

Some actions are slow or cost money: a download, a long computation, a model call. Running the same graph again should rerun only the nodes whose work would come out differently. It should also never hand back a stale or damaged file as if it were fresh. dagraph does this with content addressing:

- every node gets an **action key**, a hash of what defines its work;
- every successful run stores a **cache entry** under that key: the output paths and a hash of their contents;
- the output files live in a **CAS** (content-addressed store), a directory tree named by those hashes.

Core idea: a node's key is built from its action's kind, its inputs and the content hashes of its deps. If a stored entry exists for that key and its files still hash to the stored content hash, the node is a **hit** (`cached`) and its action does not run. Otherwise it is a **miss**: the action runs in a fresh private directory, the directory is published into the CAS, and the entry is written. Dependents key on content, not on keys, so a node that reruns and produces the same bytes stops the change from spreading further. This is **early cutoff**.

## Terms

- **Action key** (`actionKey` on a result): a 64-character lowercase SHA-256 hex string. It names the node's work and its directory in the CAS. It is `""` on a result when the node never got one: a required dep did not succeed, the key could not be computed, or the execution was cancelled before the node was processed.
- **Cache entry** (type `CacheEntry`): `{ outputs, contentHash }`. `outputs` holds the file paths the action returned, in the same shape: one path, a list of paths, or a record whose values are a path or a list of paths. `contentHash` is the hash of those files (see below). Results with status `done` or `cached` carry these same two fields.
- **Content hash**: a SHA-256 hex string over each output's name, each file's path relative to its output directory, and each file's bytes.
- **CAS base directory** (`casBaseDir`): the root under which every key gets a directory.
- **Cache**: the store of entries by key (interface `Cache`). It holds only the small manifest. The files themselves are in the CAS, read and written through the context's `DagFs`: usually the local disk (`createNodeDagFs`, `createBunDagFs`), but possibly memory (`createMemoryDagFs`).
- **DagFs**: the filesystem port the engine does all its file I/O through.

## Where caching sits in processing a node

When the engine processes a node, these steps happen in this order. The function is `processNode`. `execute` calls it only for the nodes that `orchestrate` dispatches: a node whose required dep failed is settled `dep-failed` by `orchestrate` before dispatch, and a node still waiting when the execution is cancelled is settled `cancelled` the same way. Both get `actionKey: ""` and never reach the steps below.

The steps mention per-node `force` and `cacheOnly`. These are options of `processNode` only. `execute`'s options (`ExecuteOptions`) are `force` (for every node), `onEvent`, `scheduler` and `signal`; there is no `cacheOnly` there, so `execute(g, ctx, { cacheOnly: true })` does not exist. The type of `processNode`'s options (`ProcessNodeOptions`: `force`, `cacheOnly`, `signal`, `acquire`, `onEvent`) is not exported from `@mrmeku/dagraph`; from that module only `processNode`, `ungated`, `NOT_CACHED` and `ExecutionContext` are. Code that needs to name the type writes `Parameters<typeof processNode>[4]`.

1. **Required deps.** `processNode` repeats the check for executors that call it directly. If a required dep (any dep not marked `settled`) has no entry in the `depEntries` it was given, the node settles `dep-failed` with `dep` set to that dep's name and `actionKey: ""`. Nothing is hashed.
2. **Key.** The engine hashes every file input and runs every `invalidateOn` fingerprint, then builds the key. If any of this throws, the node settles `failed` with `actionKey: ""` and `elapsed: 0`. Examples: a file input that cannot be read (message such as `ENOENT: /missing.ts`), a fingerprint that throws (its own message), or a fingerprint that returns something other than a string.
3. **Lookup.** This step is skipped when the node is forced or is `cacheable: false`. The engine reads the entry for the key. A `get` that rejects counts as a miss and is not an error. Otherwise the engine trusts the entry's shape (parsing and shape checks belong to `FsCache`, see below). If an entry exists, the engine re-hashes its files (this is **verification**). If they match `contentHash`, the node settles `cached` with the stored `outputs` and `contentHash`. A cached node has no `elapsed` and emits no `start` event.
4. **Cache-only stop.** With `cacheOnly`, a node that did not hit settles `failed` with message `not cached` (the exported constant `NOT_CACHED`). Its `actionKey` is set and `elapsed` is 0.
5. **Run.** The node waits for its concurrency slot, if it has a group (see [dagraph-execution](dagraph-execution.md)). The engine then creates `<casBaseDir>/<actionKey>/tmp-<uuid>`, emits `start`, and calls the action with `outputDir` set to the absolute form of that directory. If the directory cannot be created, or a `start` listener's promise rejects, the node fails with that error and `elapsed: 0`, and the action never runs.
6. **Publish.** The engine checks that the returned paths are under `outputDir`, hashes them, renames the directory to `<casBaseDir>/<actionKey>/out-<contentHash>`, and writes the entry. This last write is skipped for `cacheable: false`. The node settles `done` with `outputs`, `contentHash` and `elapsed`.

When the action throws, times out, is cancelled, misses an output or returns a path outside `outputDir`, the attempt directory is removed and no entry is written. When the entry write (`cache.put`) rejects, the node fails too, but its outputs are already published at `out-<contentHash>/` and are not removed. A tiered cache may already hold the local entry, so the next run can be `cached`. Publishing itself never fails: a rename that does not work falls back as described under "A damaged published copy".

Where it lives: `packages/dagraph/src/process-node.ts`, `packages/dagraph/src/orchestrate.ts`, `packages/dagraph/src/execute.ts`.

## The action key: exactly what is hashed

The key is the SHA-256 hex of a JSON array with three parts:

    [kind, [[inputName, keyedInput], ...sorted by name], [[role, keyedDep], ...sorted by role]]

**Kind.** This is the action's `kind` string. Two actions with different kinds never share an entry, even with identical inputs.

**Inputs.** These are the action's own `inputs` merged with the node's own inputs. A node may not repeat a name its action declares. Doing so fails `addNode` with `node "<name>": inputs.<input> is declared by its action "<kind>". Give the node's input another name.` A property whose value is `undefined` is dropped, as if it were absent. Each remaining input is keyed one of two ways:

- **A file input**, `file(path)`, keys as `["file", path, sha256OfBytes]`. The path is the string exactly as given, not resolved. So `file("bun.lock")` and `file("./bun.lock")` key differently, and so does the same path holding different bytes. The engine hashes the file each time the node is processed, after the node's deps have settled. So a node that depends on the node that writes the file sees the bytes that dep wrote, even if an earlier node in the same execution hashed the old bytes. Each node that declares a file hashes it separately.
- **A value input** (string, finite number, boolean, `null`, or an array or plain object of these) keys as `["value", canonical]`. `canonical` is JSON with object keys sorted at every level. Array order counts. `1` and `"1"` differ. An output ref (a pointer to one named output of a dep, made by a node's `inputs` function) keys as `#ref(<JSON of [sorted roles that name that dep, outputName]>)`. That is the role it points through plus the output's name. It is never the dep node's name and never the file's content, because the dep's content is already keyed through its role. A ref to a node that two roles name keys with both roles, sorted, whichever role it was written through.

  Values that are not JSON are refused when the action is defined or the node is added, naming their path. Examples: `inputs.ratio is NaN, which is not JSON. Give a finite number, or null.`, and similar messages for `Infinity`, a bigint, a symbol, a function, a class instance (`inputs.when is a Date, which is not JSON. Give a plain object of its fields: { ...when }.`), and `undefined` inside a list. These are part of [dagraph-graphs](dagraph-graphs.md). The point here is that every input that reaches the key is plain, canonical JSON.

**Deps, by role.** A role is the name a node gives a dep in `deps`. Each role the node gives is keyed one of three ways:

- `["content", contentHash]`: the dep's content hash. This is the default.
- `["fingerprint", sha256(fingerprintString)]`: used when the action declares `invalidateOn` for that role (see "Reading part of a dependency").
- `["missing"]`: a `settled` dep that did not succeed. The node runs without it, and runs again with a new key once the dep succeeds.

A `maybe` role the node leaves out is not in the key at all. Deps are keyed by role, not by node name. Renaming the dep nodes leaves the key unchanged. Swapping two deps between roles changes it.

**What never joins the key:**

- the node's name, or its subgraph prefix;
- the dep nodes' names;
- the node's `meta`;
- the action function itself;
- the `invalidateOn` functions themselves (only the strings they return);
- `concurrencyGroup`, `timeoutMs` and `cacheable`;
- file handles' absolute paths, the working directory, and the machine;
- anything the action reads without declaring it: a file opened by a path it builds itself, an environment variable, a clock, a network call through its ports. A change there reruns nothing. To make a node rerun when such a thing changes, declare it: a `file()` input, a value input, or a dep on a node that fetches it (with `cacheable: false` if it must be fetched every time).

A worked check, verified by running it: an action `{ kind: "hello", inputs: { version: 1 } }` with no deps has the key `sha256(JSON.stringify(["hello", [["version", ["value", "1"]]], []]))`.

Where it lives: `packages/dagraph/src/content-addressing.ts`, `packages/dagraph/src/process-node.ts`, `packages/dagraph/src/graph/inputs.ts`.

## Version inputs

The action's code is not in its key, so editing an action's logic does not invalidate anything by itself. The convention is a value input in the action's own `inputs`, such as `inputs: { version: 1 }`, bumped whenever the logic changes. The bump gives every node of the action a new key. Dependents rerun only if the new output differs (early cutoff). dagraph treats `version` as an ordinary input. The name has no special meaning to it.

Entries are never deleted, so rolling an input back to an earlier value hits that value's earlier entry. A test pins this on a chain `fetch -> parse -> summarize` in which only `summarize` carries the `version` input: run with `version: "v2"` (3 ran), then `"v3"` (1 ran, 2 hit), then `"v2"` again (0 ran, 3 hit).

## Keys across dagraph versions

The key holds no dagraph version, format tag or salt: only the kind, the inputs and the deps, as above. So a dagraph release that builds keys and content hashes the same way gives every node the same key, and upgrading to it reruns nothing. Both constructions count: dependents key on the content hash, and verification compares it. A test pins two keys as literal hex strings (in `dag.test.ts`, "a ref from the inputs function keys as the same ref written from its node did"), so a change to how those two are built fails the tests. No other test of dagraph pins a literal key or content hash.

The construction has changed once already. The latest version on npm, `@mrmeku/dagraph` `0.3.0` (`latest`, published 2026-10-16, checked with `npm view` on 2026-10-26), builds its key differently. It feeds into one SHA-256, in order, the node's name, a `config` string, each dep's node name and content hash (sorted by name), and each input file's path and hash. Its content hash is the SHA-256 of the number of output files followed by their hashes, sorted by path, with no names or relative paths. This was read from `src/content-addressing.js` in the published tarball. The current code keys the kind, the inputs and the roles instead, so no key that `0.3.0` computed matches one it computes. Upgrading from `0.3.0` to a release of the current code therefore reruns every node once. The entries `0.3.0` wrote are never read again, and their directories stay, since nothing is garbage-collected. Whether a later release may change the construction again is not settled (see Open questions).

Where it lives: `packages/dagraph/src/content-addressing.ts`, `packages/dagraph/src/dag.test.ts`.

## Content hash and early cutoff

The content hash is the SHA-256 hex of a JSON shape built from the returned outputs:

- one path `p`: `[[rel(p), sha256(bytes)]]`;
- a list: `[[[rel, hash], ...]]`, in list order;
- a record: `[[name, [[rel, hash], ...]], ...]`, sorted by output name. Each value is treated as a list.

`rel` is the file's path relative to the attempt's directory. A test pins the consequences: the same files under another key's directory or another attempt's directory give the same content hash. Swapping which file each output names, renaming the file, renaming the output, or editing the bytes does change it. Check, verified by running: one output `hello.txt` holding `hi` has content hash `sha256(JSON.stringify([["hello.txt", sha256("hi")]]))`.

Dependents key on this hash, not on the dep's action key. Early cutoff follows from that. Suppose node `a` gets a new key (say a version bump) and reruns, but writes the same bytes to the same file names. Its content hash is unchanged, so `b`, which depends on `a`, keeps its key and is `cached`, and so does everything below it. Here is the pinned example for a chain `a -> b -> c`:

| Run | Change                    | a    | b      | c        |
| --- | ------------------------- | ---- | ------ | -------- |
| 1   | first run                 | done | done   | done     |
| 2   | `a` version 2, same bytes | done | cached | cached   |
| 3   | `a` version 3, new bytes  | done | done   | cached\* |

\* In the test, `b`'s output does not depend on what `a` wrote, so `b` reruns to the same bytes and `c` is cut off one level down.

Since each dependent keys on its dep's content hash, and that dep keyed on its own deps' content hashes, the keys form a chain from the roots down, like a Merkle tree: a change anywhere reaches exactly the nodes below it whose inputs really changed, and stops at the first node that reproduces its bytes.

**A node with no outputs always cuts off.** An action may return `{}` or `[]` (a node run for its effect, such as a notification). Its content hash is then the same on every run (`sha256("[]")` for `{}`, `sha256("[[]]")` for `[]`), so a rerun of it never re-keys its dependents. Verified: a `notify` node returning `{}` with input `n: 1`, then `n: 2`, runs both times with content hash `4f53cda1…`, and its dependent is `done` then `cached`. A dependent that must rerun whenever such a node reruns needs the node to write a file that changes, such as a receipt holding what it did.

### Quick start: three runs (verified under Bun 1.4.4 and Node 22.18, 23.6, 24.0, 24.22 and 25)

A two-node graph: `count` counts the words of its input, `report` writes a sentence from the count.

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAction, execute, FsCache, Graph, nodeInputs } from "@mrmeku/dagraph";
import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";

const count = defineAction({
  kind: "count",
  inputs: { version: 1 },
  nodeInputs: nodeInputs<{ text: string }>,
  action: async ({ inputs, outputDir }) => {
    const path = join(outputDir, "count.txt");
    await writeFile(path, String(inputs.text.split(/\s+/).length));
    return path;
  },
});
const report = defineAction({
  kind: "report",
  deps: { count },
  action: async ({ depOutputs, outputDir }) => {
    const path = join(outputDir, "report.txt");
    await writeFile(path, `${await depOutputs.count.text()} words`);
    return path;
  },
});

const casBaseDir = join(await mkdtemp(join(tmpdir(), "quick-")), "cas");
const fs = createNodeDagFs();
const context = { cache: new FsCache(casBaseDir, fs), fs, casBaseDir };
async function run(text: string) {
  const graph = new Graph();
  report.addNode(graph, { deps: { count: count.addNode(graph, { inputs: { text } }) } });
  for (const r of await execute(graph, context)) console.log(r.name, r.status);
}
await run("hello big world");
await run("hello big world");
await run("goodbye small world");
```

Save it as `quick.ts` and run `bun quick.ts`, or `node quick.ts`. It was run against the package as `scripts/pack.ts` packs it for a release, under Bun 1.4.4 and Node 22.18.0, 23.6.0, 24.0.0, 24.22.1 and 25.8.1. Plain `node` runs a `.ts` file only on a Node that strips types by default. Node's TypeScript documentation (`https://nodejs.org/api/typescript.html`, whose history was read on 2026-10-26) turns stripping on by default in 22.18.0 and 23.6.0, and every release from 24.0 on has it. So `node quick.ts` runs on 22.18 and the later 22 releases, on 23.6 and the later 23 releases, and on every 24, 25 and 26 release. No single "or later" bound says this, because 23.0 to 23.5 are newer than 22.18 by number and refuse the file. Node 22.6 to 22.17 and 23.0 to 23.5 refuse `quick.ts` with `ERR_UNKNOWN_FILE_EXTENSION` (`Unknown file extension ".ts"`), before dagraph is loaded, and run it with `--experimental-strip-types` (both verified on 22.17.0 and 23.5.0). Node before 22.6, every 20 and older release included, has no type stripping: the same documentation gives 22.6.0 as the version that introduced it. Before the output, `ExperimentalWarning: Type Stripping is an experimental feature and might change at any time` is printed by every 23 release from 23.6 and by 24.0 to 24.2, since the documentation drops that warning in 22.18.0 and 24.3.0. Verified: 23.6.0 and 24.0.0 print it, and 22.18.0, 24.22.1 and 25.8.1 do not. With no `package.json`, Node 25 runs it silently. With a `package.json` that has no `type` field, which is what `npm install` writes, each of those Node versions first prints a `MODULE_TYPELESS_PACKAGE_JSON` warning; `npm pkg set type=module` stops it. Apart from that, it prints exactly:

```
count done
report done
count cached
report cached
count done
report cached
```

The first run runs both. The second finds both keys in the cache. The third changes `count`'s input, so `count` gets a new key and runs; it writes `3` again, its content hash is unchanged, so `report` keeps its key and is `cached`: early cutoff.

Where it lives: `packages/dagraph/src/content-addressing.ts`.

## Output verification

On every hit the engine re-hashes every file the entry names, streaming each one, and compares the result to `contentHash`. If a file was deleted, a file changed, or anything fails to read, the entry counts as a miss and the node reruns. A node is never `cached` with outputs that are not exactly what was stored. This costs a full read of every cached output on every run.

**A damaged published copy.** Say `out-<hash>/` was edited in place. The rerun usually produces the original content and so the same `out-<hash>` name. The rename onto it fails because that directory exists and is not empty. The engine then checks the existing copy, finds it does not match, and keeps the new attempt's `tmp-<uuid>/` directory where it is. The new entry and result point into `tmp-<uuid>/`, and later runs hit it. The damaged `out-<hash>/` is left in place. A rename that fails for any other reason (permissions, a cross-device move, a filesystem that cannot rename directories) is handled the same way: if no verified `out-<contentHash>/` exists, the attempt's `tmp-<uuid>/` stays where it is and the entry and result point into it. This is silent: the node is still `done`.

**Missing outputs.** A returned path with no file fails the node, and the failure is never cached. The message is ``output <file> was not written. Write it at `${outputDir}/<file>` before the action returns.``, where `<file>` is the returned path relative to the attempt's output directory; for an output in a record, the first `<file>` becomes `"<name>" (<file>)`. For a named output the message is `output "thumb" (audio.jpg) was not written. Write it at \`${outputDir}/audio.jpg\` before the action returns.` For a single unnamed path it is `output art/audio.jpg was not written. Write it at \`${outputDir}/art/audio.jpg\` before the action returns.` (`${outputDir}`appears literally in the message.) A path that exists but cannot be read for another reason keeps its own error. For example, returning a directory fails with an`EISDIR` message on the Bun and Node filesystems. Outputs must be files.

**Outputs outside the directory.** A returned path, absolute or relative (a relative path is resolved against the working directory), that does not resolve under `outputDir` fails with `output not under the output dir: <path> is not under <outputDir>`. `../sibling` and `/elsewhere` are both refused.

Where it lives: `packages/dagraph/src/content-addressing.ts`, `packages/dagraph/src/process-node.ts`.

## The CAS directory layout

    <casBaseDir>/
      <actionKey>/
        manifest.json           the entry, when the FsCache's base directory is casBaseDir
        manifest.json.<uuid>    an entry being written (left behind if its rename fails)
        tmp-<uuid>/             an attempt in progress (or one kept, see verification)
        out-<contentHash>/      published outputs, never written again

Rules that always hold:

- **Each attempt gets a fresh, empty, private directory.** `outputDir` is the absolute path of `tmp-<uuid>/`, and only that attempt writes to it. Two concurrent runs of the same node therefore never touch each other's files. A test pins that a concurrent run rewriting its own output never corrupts another run's dependent.
- **A successful attempt is renamed to `out-<contentHash>/`.** If another attempt already published the same content there and that copy still verifies, it is reused and the new attempt's directory is deleted. Outputs keep their path relative to the directory: `tmp-X/a/b.txt` becomes `out-<hash>/a/b.txt`.
- **A failed, timed-out or cancelled attempt's directory is removed**, best effort. A process killed mid-action leaves its `tmp-<uuid>/` behind, and nothing cleans it up later. Likewise a `manifest.json.<uuid>` whose rename failed, or whose process was killed, stays.
- **Nothing is ever garbage-collected.** Older `out-*` directories of a key stay after a newer attempt publishes. A forced rerun to different content adds another `out-*` directory and repoints the manifest. `cacheable: false` nodes publish a new `out-*` directory on every run whose content differs, and they never have a manifest.
- **An output named `manifest.json` is fine.** It lives inside `out-*/`, not beside the entry.
- **Path forms.** The action always sees absolute paths, in `outputDir` and in file handles' `.path`. The entry and the result store paths relative or absolute as `casBaseDir` is, normalized: the key directory is the pathe `join` of `casBaseDir` and the key, which drops a leading `./`, duplicate slashes and a trailing slash. So `cas`, `./cas` and `cas/` name the same thing, and under any of them the manifest holds `cas/<key>/out-<hash>/srt`, whichever form the action returned. A test pins that a CAS written under a relative `casBaseDir` and restored under another working directory still hits there.
- **On disk, switching among `cas`, `./cas` and `cas/` hits.** With the Node or Bun `DagFs`, and the same string given to `casBaseDir` and to `FsCache`, running `cas`, `./cas`, `cas/`, `cas`, `./cas` over one CAS gives done, then cached four times (confirmed by running it). The manifest `FsCache` reads under `./cas` or `cas/` is the same file on disk. Only a switch between relative and absolute misses there (next rule).
- **On the memory filesystem, every new string misses once.** `FsCache` builds its manifest path by string, not with pathe, so `cas/<key>/manifest.json`, `./cas/<key>/manifest.json` and `cas//<key>/manifest.json` are three keys of the memory filesystem's map. The same series therefore gives done, done, done, cached, cached, for every node, with outputs or without, since the lookup finds no entry at all. Each rerun reuses the existing `out-<contentHash>/` and writes a manifest of its own under the new string, so each string hits from its second use on. The CAS directory itself is normalized, so with `MemCache`, or with an `FsCache` whose base directory stays one string while `casBaseDir` changes, the memory filesystem hits too (confirmed by running it). See Open questions.
- **A stored entry hits only in the form it was written in**, relative or absolute. Verification takes each stored path relative to the current key directory, and a path that does not start with it hashes differently. So if `casBaseDir` switches between relative and absolute, or a CAS written under an absolute `casBaseDir` moves, every node with outputs misses once and reruns. Its publish then finds and reuses the existing `out-<contentHash>/` and rewrites the entry in the new form. That rewritten entry then misses for any process still using the old form. So mixing forms over one shared CAS causes repeated misses, not a single one: absolute, absolute, relative, relative, absolute over one `FsCache` gives done, cached, done, cached, done. A node with no output paths still hits.

Example manifest (FsCache writes it with two-space indentation):

    {
      "outputs": "cas/df18.../out-bf27.../page.json",
      "contentHash": "bf27..."
    }

A record output is stored the same way, e.g. `"outputs": { "joined": "cas/<k>/out-<h>/srt", "relative": "cas/<k>/out-<h>/b" }`.

Where it lives: `packages/dagraph/src/process-node.ts`, `packages/dagraph/src/cache.ts`.

## Nodes that share a key

The key depends only on kind, inputs and dep content. So two nodes declared the same way share one key, one CAS directory and one entry, even under different names, in different graphs, or with different `meta`, timeouts or groups. A test pins this: node `a` in one graph runs, then a node named `v:b` in another graph, with the same kind and inputs but a different group and timeout, is `cached` with `a`'s output.

For the same reason `processNode` can be given any graph that declares the node the same way; [dagraph-execution](dagraph-execution.md) covers its graph argument and the error when the node is missing.

Within one execution, nodes that share a key are **not** deduplicated. If both miss, both run, each in its own `tmp-<uuid>/`:

- With identical content, both publish to the same `out-<hash>/`. The second finds the first's copy, verifies it, uses it and drops its own. Both results name the same files.
- With different content (a nondeterministic action), each publishes its own `out-<hash>/` and both results' files exist. The manifest names whichever wrote last.

Tests that need nodes to stay apart give each node a distinguishing input, such as its name as an `id`.

## Reading part of a dependency: `invalidateOn`

By default a dependent reruns whenever any byte of a dep changes. An action that reads only part of a dep can say which part counts by declaring `invalidateOn: { <role>: fingerprint }`. The fingerprint is a function `(outputs, ports) => string | Promise<string>`. `outputs` is the dep's outputs as file handles, in their shape (a handle, a list, or a record). For that role, the SHA-256 of the returned string replaces the dep's content hash in the key.

Example from the tests: a summary depends on a fetched source page. A re-fetch with a different encoding changes the bytes but not the page, so the summary keys only on the page id inside the file:

    invalidateOn: { source: async (source) => idOf(await source.text()) }

A test pins that after only the source is forced to re-fetch with a different encoding, the source, the packaging step and everything below them run again, but the summary stays `cached`. When the source holds a different page id, the fingerprint changes, so the summary gets a new key and runs. That second half follows from how the key is built, but no test pins it on its own: the test runs that step with `force: true` on every node.

Rules:

- The fingerprint runs every time the node is processed, hit or miss, because the key needs it. Keep it cheap.
- Build it from file contents (`text()`, `json(guard)`, `hash()`), never from a handle's `.path`. The path differs by machine and working directory. `hash()` gives the SHA-256 of the bytes, the same hash the engine uses, and is the fingerprint to use for a binary file.
- It must return a string. Anything else fails the node, naming the role: `invalidateOn.src returned undefined, not a string. JSON.stringify returns undefined for undefined: give it the value ?? null.` (`null` is reported as `null`, other values by their `typeof`.)
- A fingerprint that throws fails the node with its own message, before the node has a key (`actionKey: ""`).
- It applies only when the dep has an entry. A `settled` dep that failed still keys as `["missing"]`.
- Output refs that point into that dep key by role and output name, not by content, so the fingerprint still decides. A test pins this: a new tarball with unchanged notes, where the fingerprint reads the notes, leaves `publish` `cached`.
- Adding or removing `invalidateOn` changes the key, because the tag changes from `content` to `fingerprint`.
- **A constant fingerprint** makes a role's changes never rerun the node: `invalidateOn: { src: () => "" }`. The node still waits for that dep, still needs it to succeed (unless the role is `settled`), and still reads its current files, but keys only on its own inputs and its other roles. Verified: with `src` given `v: "a"` then `v: "b"`, `src` runs both times and its dependent is `done` then `cached`. Use it for a dep that must exist first but whose content the node does not depend on in any way that should cost a rerun. The node's cached output then reflects whatever the dep held when it last ran.

Where it lives: `packages/dagraph/src/process-node.ts`, `packages/dagraph/src/graph/types.ts` (`InvalidateOn`, `FileHandle`), `packages/dagraph/src/file-handle.ts`.

## Running a node each time: `cacheable: false`

An action defined with `cacheable: false` has an entry that is never read or written, so its node runs in every execution. `describe()` shows `cacheable: false` on the node. The node still:

- gets a key and a key directory;
- runs in a private `tmp-<uuid>/`;
- publishes to `out-<contentHash>/`;
- reports a content hash.

Its dependents key on that content hash, so they cache normally. For example, a probe that always writes the same bytes runs every time while the report built from it stays `cached`. Under `cacheOnly`, a `cacheable: false` node always fails `not cached`. `cacheable` is not in the key. Changing an action from `false` to `true` finds an entry only if one was written before the flag was set to `false`.

## Running again and forcing

- **Plain rerun.** Every node whose key and files are unchanged is `cached`. Failures are never cached. A rerun after a partial failure therefore resumes: succeeded nodes hit, and the failed node and the nodes it held back run. A test pins `a cached, b done, c done, d done`, with `start` events only for b, c and d.
- **`execute(graph, ctx, { force: true })`** makes every node skip the lookup, run, and overwrite its entry with the new one. The next plain run hits those new entries.
- **Per-node control through `processNode` options.** An executor that calls `orchestrate` with its own run function can pass options node by node:
  - `force: true`: this node skips the lookup, runs, and writes its new entry. Its dependents are not forced. They key on its new content, so they rerun only if that changed or the fingerprint they use changed.
  - `cacheOnly: true`: look the node up without running it. With a verified entry it is `cached`. Otherwise it fails `not cached`, and its required dependents settle `dep-failed`.
  - `force` and `cacheOnly` together: there is no lookup, so the node fails `not cached` at once.

Worked example, verified by running it. A graph of `fetch`, `title` and `raw`, where `title` fingerprints only the page's `title` field and `raw` copies the whole page:

    run 1 (execute):                fetch done,   raw done,   title done
    force fetch only, page now has a new fetchedAt but the same title:
                                    fetch done,   title cached, raw done
    cacheOnly every node:           fetch cached, raw cached,  title cached

The per-node run function in that example:

    orchestrate(g.describe(), (node, depEntries, acquire) =>
      processNode(g, node.name, depEntries, ctx, { acquire, force: node.name === "fetch" }),
      unboundedScheduler());

## What is never cached

These fail or stop without writing an entry, and their attempt directory is removed:

- a node whose action threw;
- a node that timed out (`error.name` is `"TimeoutError"`, message `timed out after <ms> ms`), whatever its action returned;
- a node that was cancelled, whatever its action returned;
- a node with a missing output, or an output outside its directory;
- a node whose output ref names an output its dep did not produce (`"<node>" has no output "<output>"`);
- a node whose attempt directory could not be created;
- a node whose `start` event listener rejected (it fails with the listener's message and never runs).

These never write an entry and never create an attempt directory: a node whose key could not be computed, a `dep-failed` node, and a node that failed `not cached`.

A `cacheable: false` node never writes an entry either, but a successful run publishes and keeps its `out-<contentHash>/` directory. A node whose entry write rejected also keeps its published directory (see above).

Tests pin that a failed node fails again on the next run, rather than being served from a stale entry. A timed-out node also keeps failing until it finishes in time. `timeoutMs` is not in the key, so changing the timeout of a node that succeeded earlier still hits.

## Finding out why a node reran

dagraph keeps only the key, never what went into it. A result carries `actionKey`. The `start` event carries no key. The entry holds only `outputs` and `contentHash`. `describe()` lists neither a node's inputs nor its roles. The code that builds the key is not exported, and the package's `exports` map refuses a deep import of it: `ERR_PACKAGE_PATH_NOT_EXPORTED` under Node, `ERR_MODULE_NOT_FOUND` under Bun. No option prints the key's parts. What a reader can do:

1. **Compare the node's `actionKey` across the two executions.** A result is plain JSON, so save each execution's results to compare later. If the key is the same and the node is `done` the second time, the key did not cause the rerun. The node was forced, is `cacheable: false`, had no entry (an earlier run failed, the cache is a different one, or its `get` rejected), or its entry failed verification (a file was deleted or edited, or `casBaseDir` switched between relative and absolute form). On the memory filesystem, a changed `FsCache` base string such as `./cas` for `cas` also finds no entry. With `FsCache`, `<casBaseDir>/<actionKey>/manifest.json` shows whether the entry exists and which files it names. If the key differs, one of its parts changed, or the dagraph version did (see "Keys across dagraph versions").
2. **Compare the parts the reader can see.** The kind and the inputs come from the reader's own code. A role keyed by content is the `contentHash` on that dep's result. A fingerprinted role is the SHA-256 of the string its function returns. A file input is its path as given plus the SHA-256 of its bytes.
3. **Rebuild the whole preimage and diff it.** Built by hand from "The action key: exactly what is hashed", the preimage reproduces the engine's key exactly. `canonical` is `JSON.stringify` of the value with object keys sorted at every level, so a string `"v1"` keys as `"\"v1\""` and `1` as `"1"`. Inputs and roles are sorted with the default `sort()`. The hash is the SHA-256 hex of `JSON.stringify(preimage)`, the same from `node:crypto` (`createHash("sha256").update(text).digest("hex")`) as from `js-sha256`. Print one preimage per execution and diff the two to name the part that changed.

Verified under Bun and Node 25, against the `actionKey` of an executed node. The node is a `summarize` action with inputs `version: "v1"` and `options: { b: 1, a: [true, null] }`, a node input `config: file(<path>)`, a role `source` keyed by content and a role `other` whose fingerprint returns `"Hello"`. Its preimage is:

    ["summarize",
     [["config", ["file", "<path as given>", "<sha256 of its bytes>"]],
      ["options", ["value", "{\"a\":[true,null],\"b\":1}"]],
      ["version", ["value", "\"v1\""]]],
     [["other", ["fingerprint", "<sha256 of \"Hello\">"]],
      ["source", ["content", "<contentHash of source's result>"]]]]

An output ref inside a value input appears in its `canonical` string as `#ref(<JSON of [roles, outputName]>)`.

Where it lives: `packages/dagraph/src/content-addressing.ts`, `packages/dagraph/src/process-node.ts`, `packages/dagraph/src/graph/inputs.ts`, `packages/dagraph/package.json` (`exports`).

## Cache implementations

All are exported from `@mrmeku/dagraph`. The interface is:

- `Cache`: `get(key)` resolves to a `CacheEntry` or `undefined`; `put(key, entry)` resolves when stored.

The engine treats a rejected `get` as a miss, but a rejected `put` fails the node (see Open questions).

- **`new FsCache(baseDir, fs)`**: stores each entry as JSON at `<baseDir>/<key>/manifest.json`, through the given `DagFs`. A put writes `manifest.json.<uuid>` beside the target, then renames it into place. A concurrent `get` therefore sees the whole old entry or the whole new one, never half of either (pinned by a test). `get` returns `undefined` for a missing file, unparsable JSON, or JSON that is not `{ outputs, contentHash }` with valid outputs and a string hash. Its errors are swallowed. These checks are `FsCache`'s own: the engine trusts whatever a `Cache` returns and only re-hashes the files it names, so a custom `Cache` must return a well-formed `CacheEntry` or `undefined`. `put` relies on `writeText` creating `<baseDir>/<key>/`. If the rename fails, `put` rejects and leaves `manifest.json.<uuid>` behind. The layout above holds when `baseDir` equals `casBaseDir`.
- **`new MemCache()`**: entries held in a `Map` in memory and lost when the process exits. Meant for tests.

Where it lives: `packages/dagraph/src/cache.ts`.

## The DagFs port

`DagFs` is every filesystem operation the engine performs: hashing, the CAS, file handles, and `FsCache`. Each is a plain function, and the engine calls each one detached (`fs.hashFile(path)`), so an implementation must not use `this`. The members:

| Member                     | Takes               | Gives                                                                                                                                                                                      |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `exists(path)`             | a path              | whether a file is there. Reliable only for files: the Node implementation reports true for a directory, the Bun and memory ones false for every directory. The engine never calls it.      |
| `readText(path)`           | a path              | the file's text                                                                                                                                                                            |
| `writeText(path, content)` | a path and a string | writes the file, creating missing parent directories in all three implementations                                                                                                          |
| `hashFile(path)`           | a path              | the SHA-256 hex of the bytes; rejects with an error whose `code` is `"ENOENT"` when there is no file, as `node:fs` does. The engine uses that code to name an output that was not written. |
| `ensureDir(path)`          | a path              | makes the directory, with its parents                                                                                                                                                      |
| `rename(from, to)`         | two paths           | POSIX rename: replaces a file at `to` atomically; fails when `to` is a non-empty directory. Publishing relies on this.                                                                     |
| `remove(path)`             | a path              | deletes a file, or a directory recursively; does nothing if it is absent                                                                                                                   |
| `readdir(dir)`             | a directory         | entry names; `[]` if the directory is absent                                                                                                                                               |
| `resolve(path)`            | a path              | the absolute form, as an action sees it                                                                                                                                                    |

The execution context passed to `execute` and `processNode` is `ExecutionContext`: `{ cache, fs, casBaseDir, ports? }`. `ports` is required exactly when the graph's actions need ports. The engine passes them through untouched. The action context (`ActionContext`: `inputs`, `depOutputs`, `ports`, `outputDir`, `signal`, `output`) holds no file system, so an action writes its files any way it chooses: directly with `node:fs`, as the quick start does, or through a port, as the complete example below does. The engine then reads, hashes and moves them through the context's `fs`. The tests put the same `DagFs` in both places.

Three implementations:

- **`createNodeDagFs()`**, from the `@mrmeku/dagraph/fs/node` entry point. Built on `node:fs/promises`. `writeText` creates missing parent directories with `mkdir -p`. `hashFile` streams the file through `node:crypto`.
- **`createBunDagFs()`**, from the `@mrmeku/dagraph/fs` entry point. Built on `Bun.file`, `Bun.write` and `Bun.CryptoHasher`, so it needs the Bun runtime. `Bun.write` creates missing parent directories. Hashing streams the file.
- **`createMemoryDagFs(initial?)`** and its type `MemoryDagFs`, from the package index. Files live in a `Map` exposed as `.files`, so a test can seed or inspect it; `initial` is a record of path to string or bytes. Hashing a string hashes its UTF-8 bytes. It differs from a real disk in these ways:
  - only files exist: a directory is just the files under its prefix, which `readdir`, `rename` and `remove` see, and `exists(dir)` is false for every directory, empty or not;
  - `ensureDir` does nothing;
  - `resolve` returns the path unchanged;
  - `rename` moves a file or every file under a directory. It throws `ENOENT: <from>` if nothing is there. When the source is a directory, it throws `ENOTEMPTY: <to>` if the target holds files. When the source is a file, it never checks the target, so renaming a file onto a non-empty directory succeeds and leaves a file and a directory sharing one name, which POSIX refuses.

Why the two real ones are separate entry points: they import `node:fs`, and the package index must stay free of I/O modules because it is bundled into Temporal's workflow sandbox. Import the index for the engine, the caches and the memory filesystem; import `/fs` or `/fs/node` for disk.

A file handle (what an action receives for a file input or a dep output) reads through the same `DagFs`. Its `text()` refuses a file whose bytes are not valid UTF-8, with `<abs> is not UTF-8 text: decoding it lost bytes. Hash its bytes with hash().`. A file that genuinely contains U+FFFD reads normally.

Where it lives: `packages/dagraph/src/cache.ts` (`DagFs`), `packages/dagraph/src/ports/node-fs.ts`, `packages/dagraph/src/ports/fs.ts`, `packages/dagraph/src/ports/memory-fs.ts`, `packages/dagraph/src/file-handle.ts`, `packages/dagraph/package.json` (`exports`).

## A complete example (runs with Node's filesystem; verified)

    import { Graph, FsCache, actionsFor, execute, type DagFs } from "@mrmeku/dagraph";
    import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";

    type Ports = { fs: DagFs };
    const defineActionWithPorts = actionsFor<Ports>();
    const fetchPage = defineActionWithPorts({
      kind: "fetch",
      inputs: { version: 1 },
      action: async (c) => {
        const path = `${c.outputDir}/page.json`;
        await c.ports.fs.writeText(path, JSON.stringify({ title: "Hello" }));
        return path;
      },
    });
    const title = defineActionWithPorts({
      kind: "title",
      inputs: { version: 1 },
      deps: { fetchPage },
      invalidateOn: { fetchPage: async (page) => JSON.parse(await page.text()).title },
      action: async (c) => {
        const path = `${c.outputDir}/title.txt`;
        await c.ports.fs.writeText(path, JSON.parse(await c.depOutputs.fetchPage.text()).title);
        return path;
      },
    });
    const build = () => {
      const g = new Graph<Ports>();
      title.addNode(g, { deps: { fetchPage: fetchPage.addNode(g, {}) } });
      return g;
    };
    const fs = createNodeDagFs();
    const ctx = { ports: { fs }, fs, cache: new FsCache("cas", fs), casBaseDir: "cas" };
    await execute(build(), ctx); // fetch: done, title: done
    await execute(build(), ctx); // fetch: cached, title: cached

After this, `cas/` holds one directory per key. Each holds `manifest.json` and one `out-<contentHash>/` with `page.json` or `title.txt` in it. The result of `fetch` looks like `{ name: "fetch", actionKey: "<64 hex>", status: "done", outputs: "cas/<key>/out-<hash>/page.json", contentHash: "<64 hex>", elapsed: 2 }`.

## Open questions

1. **A rejected `put` fails the node, but a rejected `get` is only a miss.** The outputs were already published when the write fails, and they stay. A `Cache` that writes in two places, where the first write lands before the second fails, makes the node report `failed` and the next run `cached`. Is a failed entry write meant to fail the node?
2. **A damaged `out-<hash>/` is never repaired or removed.** After verification finds it damaged, the new attempt's `tmp-<uuid>/` serves as the published copy. Every later attempt that produces the same content runs into the damaged directory again and keeps its own `tmp-` directory. Intended?
3. **There is no garbage collection** of old `out-*` directories, of left-over `tmp-*` directories from killed processes, or of manifests nothing uses. The code has nothing that bounds the CAS's size.
4. **`FsCache` joins paths by string** (`<baseDir>/<key>/manifest.json`), while the CAS directory is joined and normalized. On disk it makes no difference. On the memory filesystem a `baseDir` of `./cas` or `cas/` instead of `cas` finds no entry, so every node reruns once (see "The CAS directory layout"). Is the manifest path meant to be normalized too?
5. **No stated policy on key stability across releases.** The key carries no format version, and only two literal keys are pinned by a test. Nothing in the code or the release scripts says whether a release may change how keys or content hashes are built, or whether such a change needs a new major version. The change since `0.3.0` reruns every node once. Is every such change meant to be called out in a release?
6. **Nothing records a key's parts.** Explaining a rerun means rebuilding the preimage by hand, because no result, event or entry holds it and the code that builds it is not exported. Is that intended, or should the engine expose the preimage, for example on a result or an event?
