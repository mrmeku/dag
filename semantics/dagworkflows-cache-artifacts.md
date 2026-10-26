# dagworkflows: the cache and artifacts as nodes

## The problem and the core idea

A CI job on GitHub starts on a fresh machine. Everything the last run built is gone, unless the job carries it over with `actions/cache`. Files the job wants to keep for people to download (a tarball, a test report) leave the machine with `actions/upload-artifact`. In an ordinary GitHub workflow these are YAML steps. They run in a fixed place in a straight list, and they cannot see the graph that dagworkflows runs.

dagworkflows makes both of them nodes of the graph:

- `workflow.cache(spec)` adds a **restore** node, `restore:<name>`, and returns a `save()` function that adds a **save** node, `save:<name>`. Tasks that need the cached files depend on the restore. The save runs after every other task of the run, whatever became of them.
- `workflow.uploadArtifact(spec)` adds one node that uploads files as an artifact of the run. The files can be another node's outputs, straight from the CAS.

Both talk to the outside world through two **ports** (swappable interfaces in the run's `Ports`): `cacheStore` and `artifactStore`. On GitHub they are the actions toolkit (`@actions/cache`, `@actions/artifact`). Locally the cache store copies files between git worktrees, and the artifact store does nothing. Tests use in-memory stores. So one workflow file runs unchanged on a laptop and on GitHub.

The main use is **caching the CAS between runs**. The CAS (content-addressed store, the `--cas-dir` directory, `.dag/cas` by default) holds the outputs of every cached node, keyed by action key (see [dagraph-caching](dagraph-caching.md)). Restore the CAS directory before the tasks run, and every task whose inputs did not change is a cache hit (`cached`) on a fresh machine too.

Terms used on this page:

| Term                         | Meaning                                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Cache entry                  | What the cache store holds under one key: the files of the cache's `path`, as they were when saved.                        |
| Key                          | The name a save stores an entry under, and the first name a restore looks for.                                             |
| Restore keys                 | Prefixes a restore tries, in order, when no entry has the key.                                                             |
| Hit / miss                   | A restore that found an entry, or one that found none.                                                                     |
| Partial save                 | A save after a run where some task did not succeed. It stores under `<key>-partial-<run id>`, never under the key.         |
| Artifact                     | A named archive of files that belongs to one GitHub run, shown on its run page.                                            |
| Cache store / artifact store | The ports (`CacheStore`, `ArtifactStore`) the nodes go through.                                                            |
| Post step                    | A release a task owes once it starts (see [dagworkflows-lifecycle](dagworkflows-lifecycle.md)). A save is not a post step. |

Where it lives: `packages/dagworkflows/src/cache.ts`, `src/steps.ts`, `src/ports.ts`, `src/ports/cache-store.ts`, `src/ports/artifact-store.ts`, `src/ports/local.ts`.

## A worked example: caching the CAS

This is the pattern the repository's own CI uses (`scripts/ci.ts`):

```ts
import { defineWorkflow } from "@mrmeku/dagworkflows";

export default defineWorkflow({
  implementation: async (workflow) => {
    const cas = workflow.cache({
      name: "cas",
      path: [".dag/cas"],
      key: `ci-main-${workflow.ctx.sha}`,
      restoreKeys: ["ci-main-"],
    });
    const build = workflow.task({
      name: "build",
      shell: 'echo built > "$OUT"',
      env: ({ out }) => ({ OUT: out.report }),
      outputs: { report: "report.txt" },
      inputs: { version: "build-v1" },
      deps: { cas: cas.restore },
    });
    workflow.uploadArtifact({
      name: "upload:report",
      artifact: "report",
      deps: { build },
      path: ({ build }) => [build.report],
    });
    if (workflow.ctx.ref === "refs/heads/main") cas.save();
  },
});
```

What happens on GitHub, run by the action:

1. `restore:cas` runs first. It asks the cache service for `ci-main-<this sha>`. On a new commit there is no such entry, so it tries the prefix `ci-main-` and gets the newest entry whose key starts with it: the CAS that the last run on `main` saved. Its log says `Cache restored from: ci-main-<older sha>` and `Restored: .dag/cas`.
2. `build` depends on `cas.restore`, so it starts only after the restore. Its inputs have not changed, so the restored CAS already holds its output and it is `cached`.
3. `upload:report` uploads `report.txt` from the CAS as the artifact `report`.
4. On `main`, `save:cas` runs after every other node. If all of them succeeded, it saves `.dag/cas` under `ci-main-<this sha>`. The next commit's run restores that entry through the `ci-main-` prefix.

On a pull request the save is not added, so a PR reads main's CAS and never writes one.

The same file run locally with `dag run ci.ts --output-style grouped`, in a fresh git repository on branch `main` with at least one commit and no earlier run, prints this (checked in a temporary directory; times will differ):

```
▶ ci.ts · ref=refs/heads/main · 4 nodes
    restore:cas
    build
    upload:report
    save:cas
▷ restore:cas
▶ ✔︎ restore:cas (9ms)
    Cache not found for input keys: ci-main-a3878d35683f452b305a2897d551961075d93d4f, ci-main-
▷ build
▶ ✔︎ build (7ms)
▷ upload:report
▶ ✔︎ upload:report (1ms)
    Artifact report not uploaded: no artifact service
▷ save:cas
▶ ✔︎ save:cas (1ms)
    Cache not saved with key: ci-main-a3878d35683f452b305a2897d551961075d93d4f
```

Locally `ctx.ref` is `refs/heads/<current branch>`, so the save is added only on a branch named `main`. On `master` the banner reads `3 nodes` and there is no save line. With no commit yet, `sha` is the literal `HEAD` (below), and the key is `ci-main-HEAD`.

The second local run prints `Kept, already there: .dag/cas` under the restore's miss line, and `build` shows as `cached`. Locally the CAS never left the disk, so the save has nothing to do.

## `workflow.cache`

`workflow.cache(spec)` takes an `ActionsCacheSpec`:

| Field         | Type     | Default   | Meaning                                                                    |
| ------------- | -------- | --------- | -------------------------------------------------------------------------- |
| `name`        | string   | `"cache"` | Names the two nodes, `restore:<name>` and `save:<name>`.                   |
| `path`        | string[] | required  | What the cache holds, as `actions/cache`'s `path` input.                   |
| `key`         | string   | required  | The entry to look for first, and the key a full save stores under.         |
| `restoreKeys` | string[] | `[]`      | Prefixes to try in order after `key`, as `actions/cache`'s `restore-keys`. |

It adds the restore node at once. It returns an `ActionsCacheTasks`:

- `restore`: the restore node's ref (`NodeRef<Record<never, string>>`, a ref with no outputs). Give it as a dep: `deps: { cas: cas.restore }`.
- `save(saveSpec?)`: adds the save node and returns nothing. `saveSpec` is a `SaveSpec` with one field, `partial`, `"save"` (default) or `"skip"`.

The exported types are `ActionsCacheSpec`, `ActionsCacheTasks` and `SaveSpec`.

Two caches need two names. A second `workflow.cache` with the same name, or a second `save()` call on one cache, fails while the graph is built with the engine's error `Duplicate node name "restore:cas". Names are unique in a graph: …` (or `"save:cas"`). Several caches in one workflow are fine, for example one for the CAS and one for a package manager's directory.

Where it lives: `packages/dagworkflows/src/cache.ts`, `src/workflow.ts`.

## The restore

The restore runs on every run. It is never cached (`cacheable: false`), so a CAS hit can never skip it.

It calls the cache store with the `path`, the `key` and the `restoreKeys`. The store tries the exact `key` first, then the newest entry whose key starts with `key`, then each restore key in turn as a prefix (the exact rules depend on the store, below; the worktree store ignores keys). The partial-key sequence under _The save_ depends on the second step: run 102 finds `deps-1-partial-101` with no restore keys. It logs one of these:

- On a hit: `Cache restored from: <what it restored from>`. Then, if any entry of `path` holds something now that held nothing before, `Restored: <those entries, comma-separated>`.
- On a miss: `Cache not found for input keys: <key>, <restore keys…>`.
- In both cases, if any entry of `path` already held something before the restore, a last line `Kept, already there: <those entries>`.

"Holds something" means a file, or a directory with a file somewhere inside it. An empty directory holds nothing. This check follows symbolic links, so a link that leads nowhere holds nothing. The worktree store (below) does not follow them: to it, any link holds something, even one that leads nowhere. So a `path` entry that is a dangling link is neither filled by the worktree store nor listed under `Kept, already there:`. The run makes the CAS directory, empty, before any node starts, so a fresh machine's `.dag/cas` counts as holding nothing. A `path` entry that is a glob pattern, or that starts with `~`, is never listed in `Restored:` or `Kept, already there:`. The check reads the path literally, though the GitHub store may still restore it.

**The restore has no outputs.** Its dependents' action keys come from their deps' content hashes (see [dagraph-caching](dagraph-caching.md)), and a node with no outputs has the same content hash every time. So a hit and a miss key the dependents alike, and no task can tell which one happened. A restore only orders its dependents after it. What it restores (the CAS) is what makes them cache hits. A task that does not depend on the restore can start before the CAS is in place and miss a hit it would otherwise have had.

**Failure.** Caching is optional, as in the toolkit:

- A store error other than a validation error is a warning, `Failed to restore: <message>`, followed by the miss line. The restore succeeds and its dependents run.
- A `ValidationError` (an invalid key, or no path) fails the restore with the store's message, for example `Key Validation Error: in,valid cannot contain commas.`. Its dependents are then skipped as `dep-failed` (dependency failed). The cache's save is not among them: it waits on the restore as a settled dep, so it runs, sees a node that did not succeed, and with `partial: "save"` tries `<key>-partial-<run id>`, which is invalid too. It fails with a `ValidationError` as well, for example `Key Validation Error: in,valid-partial-<run id> cannot contain commas.`, and the run has two failed cache nodes. With `partial: "skip"` the save logs `Not saving cache: …` and succeeds.

A warning is written into the node's log as a GitHub warning command titled with the node's name, for example `::warning title=restore%3Acas::Failed to restore: EACCES: permission denied, copyfile`. How warnings are shown is [dagworkflows-output](dagworkflows-output.md)'s domain.

Where it lives: `packages/dagworkflows/src/cache.ts`.

## The save

`cas.save()` adds `save:<name>`. These rules always hold:

- **It waits for every other node of the run.** Its deps are settled deps (deps it runs after whatever they did) on every node of the run except post steps and other saves. That includes the restore and tasks that never used the cache. The full list is worked out when the run starts, so a node added after `save()` was called is still waited for. A save does not wait for post steps, and saves do not wait for each other.
- **It is never cached.** It runs every time. The store decides whether anything is stored: a store saves only a key it does not hold yet. So a second run with the same key saves nothing, and an entry the service has evicted is saved again.
- **It is ordinary work, not a post step.** Nothing owes it. A cancel stops it like any other node, and the post pass after a cancel never runs it.
- **Nothing depends on it.** It has one output, `saved`, the file `save.json`, which holds `true` or `false`: whether the store saved.

**What it saves under.** The save looks at each node it waits for. A node that did not succeed (`failed`, `dep-failed` or `cancelled`) gave no outputs. A `cached` node counts as a success.

- Every node succeeded: it saves `path` under `key`.
- Some node did not, with `partial: "save"` (the default): it saves under `<key>-partial-<run id>`. The run id is `workflow.ctx.runId`, GitHub's run id, and `0` locally. A flaky test then still leaves the work that succeeded in the cache. The next run's restore finds the partial entry, because the key is a prefix of it. A partial save never takes the key itself, so a later green run still saves under the key. A re-run of a failed GitHub job keeps its run id (no attempt number is in the key): if the first attempt stored `<key>-partial-<run id>`, a re-run that fails again builds the same key and saves nothing (`Cache not saved with key: …`). Only a green re-run stores something new, under `key`.
- Some node did not, with `partial: "skip"`: it saves nothing and logs `Not saving cache: <n> of the run's nodes did not succeed.`. This matches `actions/cache`'s `post-if: success()`. `save.json` holds `false`.

A failed post step does not count, since the save does not wait for post steps.

The test in `src/release.test.ts` pins this sequence. Key `deps-1`, no restore keys, a GitHub-like store, `e2e` failing on run 101:

| Run                                            | Restore log                               | Entries afterwards             |
| ---------------------------------------------- | ----------------------------------------- | ------------------------------ |
| 101, e2e fails                                 | `Cache not found for input keys: deps-1`  | `deps-1-partial-101`           |
| 102, all green                                 | `Cache restored from: deps-1-partial-101` | `deps-1-partial-101`, `deps-1` |
| 103, e2e fails, `partial: "skip"`, empty store | `Cache not found for input keys: deps-1`  | none                           |

**What it logs.**

- `Cache saved with key: <saved key>` when the store saved, and `save.json` is `true`.
- `Cache not saved with key: <saved key>` when the store declined (it held the key, or the toolkit returned no cache id), and `save.json` is `false`.
- A store rejection other than a validation error: a warning `Failed to save: <message>`, `save.json` is `false`, and the node succeeds. This needs a store that rejects, such as a test store whose save throws `Cache service responded with 429`, and it does not turn the run red. `createActionsCacheStore` does not reject there: `@actions/cache` catches a refused save, a 429 included, and returns `-1`. The node then logs `Cache not saved with key: …`, and the toolkit's own `Failed to save: …` goes to the job output.
- A `ValidationError` fails the node with the store's message. A failed save is a failed node, so the run exits 1.

**Cancel.** A save still waiting when the run is cancelled settles as `cancelled` without running, so a cancelled run saves nothing. A save already running when the cancel lands is reported `cancelled` too. The store call it started is not undone: in the test, the store holds the entry although the node shows `cancelled`.

**`--only`.** A run with `--only <names>` runs the closure of those nodes (the nodes and everything they depend on). A save joins it when its restore is in that closure, and then waits only for the nodes of the selection. Example: lint and test both depend on `cas.restore`. `dag run ci.ts --only lint` runs `restore:cas`, `lint` and `save:cas`. The save comes after lint, and a green lint saves under the full key. Since a save depends on its restore, `--only save:cas` (or `--only restore:cas`) runs just the restore and the save: once the restore is green, the save stores `path` as it is on disk under the full `key`, though no task ran. A selection that does not reach the restore (`--only docs`, when docs does not depend on `cas.restore`) runs neither.

Where it lives: `packages/dagworkflows/src/cache.ts`, `src/select.ts`.

### A save of your own

When the built-in save's rule (wait for everything, then save under the key or a partial key) is not what you want, write the save as an action task over the same port. Every action gets `ports.cacheStore` (it is part of `WorkflowPorts`), so `await ports.cacheStore.save(paths, key)` stores the paths under the key, and resolves `true` if it stored them and `false` if the store already held that key. `ports.cacheStore.restore(paths, key, restoreKeys)` is available the same way. For example, a save that stores the CAS only when `test` succeeded, and never a partial entry:

```ts
const cas = workflow.cache({ name: "cas", path: [".dag/cas"], key: "cas-1" });
const test = workflow.task({ name: "test", cmd: ["npm", "test"], deps: { cas: cas.restore } });
workflow.task({
  name: "save:green",
  deps: { test },
  action: async ({ ports, log }) => {
    const saved = await ports.cacheStore.save([".dag/cas"], "cas-1");
    log(saved ? "saved" : "already there");
  },
});
```

Verified with `createTestPorts` and a memory cache store: a run where `test` fails leaves `save:green` `dep-failed` and the store empty; a green run makes it `done` and the store holds `cas-1`.

A save written this way is an ordinary task, so it differs from `save()` in each of these ways:

- It waits only for its own `deps`. Use `settled(...)` deps to make it run after a failure, and list every node it must wait for: nothing adds nodes to its deps for you, and a node added later is not waited for.
- `--only` does not pull it in: a selection gets it only by naming it (it is a dependent, not a dependency, of what it waits for). The built-in save joins any selection that holds its restore.
- Nothing logs `Cache saved with key:` or writes `save.json` unless your action does, and no partial key is made unless you build one (`` `${key}-partial-${workflow.ctx.runId}` ``).
- Any rejection of the store fails it, a `ValidationError` or not. The built-in save turns every other error into a `Failed to save:` warning; catch errors yourself to do the same.
- Without inputs it is not cached, so it runs on every run its deps allow, as the built-in save does. Do not give it `cacheable: true`: a cache hit would skip the save.
- Locally the worktree store's `save` does nothing and resolves `false`; on GitHub, outside the action, `nullCacheStore` does the same.

## `workflow.uploadArtifact`

`workflow.uploadArtifact(spec)` adds one node and returns its ref, `NodeRef<Record<"response", string>>`. It takes an `UploadArtifactSpec`:

| Field              | Type                                         | Default       | Meaning                                                                                                                           |
| ------------------ | -------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | string                                       | required      | The node's name.                                                                                                                  |
| `artifact`         | string                                       | required      | The artifact's name on the run page. GitHub refuses `"`, `:`, `<`, `>`, `\|`, `*`, `?`, `\` and `/`. Nothing checks this locally. |
| `path`             | string[], or a function of the deps' outputs | required      | What to upload (below).                                                                                                           |
| `deps`             | dep record                                   | none          | The nodes whose outputs `path` reads.                                                                                             |
| `ifNoFilesFound`   | `"warn"` \| `"error"` \| `"ignore"`          | `"warn"`      | What an empty file list does.                                                                                                     |
| `overwrite`        | boolean                                      | unset         | Delete an artifact of the same name in this run first. A re-run of a failed job shares its run's artifacts.                       |
| `retentionDays`    | number                                       | the service's | Passed to the service.                                                                                                            |
| `compressionLevel` | number                                       | the service's | Passed to the service.                                                                                                            |

`overwrite`, `retentionDays` and `compressionLevel` together are the exported type `ArtifactUploadOptions`.

**`path`.** It is either a list of globs or a function. The function gets the deps' outputs as file handles, the same handles an action's `depOutputs` gives, and returns a list. Each item of that list is a glob, a handle, a list of handles, or `undefined`. An `undefined` item is left out. That is what a `settled` dep that failed gives, so a report from a test that may fail is written like this:

```ts
workflow.uploadArtifact({
  name: "upload:report",
  artifact: "report",
  deps: { tests: settled(tests) },
  path: ({ tests }) => [tests?.report],
});
```

The types make you write `tests?.report` for a settled dep: `tests.report` does not compile. A function can mix both kinds of item: `path: ({ pack }) => ["reports/**", pack.tarball]`.

Globs are matched when the upload runs, not when the graph is built. They are matched by `@actions/glob`'s rules, relative to the process's working directory, and give files only. Directories named in `DEFAULT_EXCLUDES` (`.git`, `node_modules`, `.dag`) are left out, at any depth, so a nested `node_modules` is skipped too. So a glob stays out of the CAS while the CAS sits under a directory named `.dag`, as the default `.dag/cas` does. With a `--cas-dir` elsewhere, a glob such as `**/*.tgz` can match files in the CAS. To upload a node's output, use a dep's handle. A handle is the file the dep produced, in the CAS, so `path: ({ pack }) => [pack.tarball]` uploads a tarball straight from the CAS. The files are the sorted glob matches, as paths relative to the working directory, followed by the handles' files, whose paths are always absolute (whatever `--cas-dir` is).

**Archive layout.** Files are archived relative to the deepest directory that holds all of them, as `actions/upload-artifact` does. The paths are compared as strings, segment by segment. One file, or one node's outputs, sit at the top of the artifact. Files of two nodes are under their two CAS directories, relative to the CAS root. When the files share no directory, the root is `.`, which `@actions/artifact` takes as the working directory. Because glob matches are relative and handles absolute, any `path` that mixes the two (`["reports/**", pack.tarball]`) gets the root `.`, even when every file sits in one directory. A handle's file then sits deep in the artifact, at its path from the working directory (`.dag/cas/…`). A `path` of handles only, from a CAS outside the working directory, gets that CAS's deepest shared directory as its root and uploads without error. A file outside the working directory makes the upload fail only when the root falls back to `.`: with a `path` that mixes globs and handles, or with files that share only `/`. The error is `@actions/artifact`'s `The rootDirectory: … is not a parent directory of the file: …`.

**What happens.**

- The upload runs on every run. It is never cached: artifacts belong to a run.
- No files found: the message is `No files were found with the provided path: <globs, comma-separated>. No artifacts will be uploaded.`. Without globs it is `No files were found with the provided path. No artifacts will be uploaded.`. With `"warn"` it is a warning, with `"ignore"` a plain log line, and with `"error"` the node fails with it. In each case nothing is uploaded.
- Uploaded: the log says `Artifact <artifact> has been successfully uploaded! Final size is <size> bytes. Artifact ID is <id>`.
- No service (locally, or in a `run:` step on GitHub): nothing is uploaded and the log says `Artifact <artifact> not uploaded: no artifact service`. The node succeeds.
- A service error fails the node, as the action fails its step. On GitHub, a second upload under a name the run already has is refused unless `overwrite` is set.

**Output.** `response` is the file `artifact.json`. It holds `{ "id": <id>, "size": <bytes> }` (JSON, two-space indent), or `null` when nothing went up (no files, or no service).

The release workflow (`scripts/release.ts`) uploads each package's tarball like this, and the action bundle as `path: ({ bundle }) => [bundle.main, bundle.post]`.

Where it lives: `packages/dagworkflows/src/steps.ts`, `src/ports/glob.ts`, `src/config.ts` (`DEFAULT_EXCLUDES`).

## The cache store port

`CacheStore` (exported type) has two functions:

- `restore(paths, key, restoreKeys)` puts `paths` back from the entry under `key`, or else from the newest entry whose key starts with `key` or with a restore key. It resolves to what it restored from, or `undefined` on a miss.
- `save(paths, key)` stores `paths` under `key` unless the store already has an entry for it. It resolves to whether it saved.

A rejection named `ValidationError` (invalid key or path) fails the node. Any other rejection is a warning.

Implementations:

| Store                                  | Where                                       | Behaviour                                                  |
| -------------------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| `createActionsCacheStore(cache)`       | GitHub, when the cache service is reachable | `@actions/cache` (below).                                  |
| `nullCacheStore`                       | GitHub, when the service is not reachable   | Every restore misses, every save resolves `false`.         |
| worktree store (not exported)          | Local `dag run` and `dag post`              | Copies from the main git checkout into a worktree (below). |
| `createMemoryCacheStore(initialKeys?)` | Tests                                       | In memory, with the service's matching rules (below).      |

**`createActionsCacheStore(cache)`** takes `@actions/cache`'s module, or any object with its `restoreCache` and `saveCache`. A restore is `restoreCache(paths, key, restoreKeys)` as is. A save asks first. It does a lookup-only restore of `key` with no restore keys. If the service holds that key, it returns `false` without saving. The key is compared as `actions/cache`'s `isExactKeyMatch` compares it, ignoring case (`Cas-1` matches `cas-1`, an accented letter does not match its plain one). The service matches a key as a prefix too, so a lookup can come back with a longer key: held `cas-10`, saving `cas-1`, it saves. If the lookup itself fails, it saves anyway. Then `saveCache(paths, key)`: a cache id of 0 or more is `true`, and the toolkit's `-1` (did not save) is `false`.

The toolkit catches most of its own errors. Its restore logs `Failed to restore: …`, as an error annotation for a 5xx and as a warning otherwise, and resolves `undefined`, a miss. So a 5xx on restore raises an error annotation while the restore node succeeds. The save's lookup goes through the same restore, so a 5xx there raises one too before the save goes ahead. Its save logs and returns `-1`: as info for `Failed to save: Unable to reserve cache with key …, another job may be creating this cache`, as an error for a 5xx, and as a warning otherwise. A save path that does not exist is one of these too. Only `ValidationError`s reach the node. The toolkit raises them for a key over 512 characters, a key with a comma, more than 10 keys in all, or no paths. The toolkit writes these messages with `@actions/core` straight to the job's output, not into the node's log.

**The worktree store** is what a local run uses. It ignores keys. Locally the cache's paths stay on disk where the last run left them, so its `save` does nothing and resolves `false`. Every local save logs `Cache not saved with key: …`. Its `restore`:

1. Asks git for the main checkout (the first `worktree` of `git worktree list --porcelain`), this checkout's top level, and the current directory's path within the repository. Outside git, or in the main checkout itself, it resolves `undefined`: a miss.
2. For each entry of `paths` that is relative (not absolute, and not starting with `~`), it makes the entry's parent directory. It takes a lock on the entry, the lock file `<entry>.lock`. If another restore holds that lock, it waits until the lock is released, or goes stale about 10 s after a kill.
3. Under the lock, if the entry holds nothing here and the same place in the main checkout holds something (a file, any link, or a directory with one of these inside), it copies it over. The copy is recursive, keeps symbolic links as they are (a link that leads nowhere is copied too), and keeps timestamps.
4. It resolves to the main checkout's path if it copied anything, else `undefined`.

It never overwrites what the worktree has, and never touches a path outside it. So a new worktree starts from the main checkout's CAS and then keeps its own. In the CLI test, three runs give `Cache not found…` in the main checkout, `Cache restored from: <main checkout>` and `Restored: .dag/cas` in a new worktree (where `build` is then `cached`), and `Cache not found…` plus `Kept, already there: .dag/cas` on the worktree's next run.

**`createMemoryCacheStore(initialKeys = [])`** returns a `MemoryCacheStore`, a `CacheStore` with `entries`: a `Map` from each saved key, in order, to the paths it holds. The initial keys hold `[]`. A restore returns `key` if it is held. Otherwise, for `key` and then each restore key, it returns the newest entry whose key starts with it. A save of a held key returns `false`, and otherwise records the key and returns `true`. Deleting from `entries` is an eviction. It moves no files.

Where it lives: `packages/dagworkflows/src/ports.ts`, `src/ports/cache-store.ts`, `src/ports/local.ts`, `src/config.ts`.

## The artifact store port

`ArtifactStore` (exported type) has one function, `upload(name, files, rootDirectory, options)`. It sends `files` as the artifact `name`, each by its path from `rootDirectory`. It resolves to `{ id, size }`, or `undefined` when there is no store to take it. It rejects a name the run has already used, unless `options.overwrite` replaces that artifact.

| Store                                | Where                                          | Behaviour                                                                                                        |
| ------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `createActionsArtifactStore(client)` | GitHub, when the artifact service is reachable | An `@actions/artifact` client (`DefaultArtifactClient`, or anything with `uploadArtifact` and `deleteArtifact`). |
| `nullArtifactStore`                  | Locally, and on GitHub without the service     | Every upload resolves `undefined`.                                                                               |
| `createMemoryArtifactStore()`        | Tests                                          | In memory, with the service's one-name-per-run rule.                                                             |

**`createActionsArtifactStore(client)`**: with `overwrite`, it first deletes the run's artifact of that name. `ArtifactNotFoundError` (no such artifact yet) is ignored, and any other delete error fails the upload (for example `403 Forbidden`). It then calls `uploadArtifact(name, files, rootDirectory, { retentionDays, compressionLevel })`, passing only the options that are set. A response without an id resolves `undefined`, and a missing size becomes `0`.

**`artifactServiceAvailable(env)`** is `true` when the environment has both `ACTIONS_RUNTIME_TOKEN` and `ACTIONS_RESULTS_URL`. Those are what `@actions/artifact` needs.

**`createMemoryArtifactStore()`** returns a `MemoryArtifactStore` with `uploads`: a `Map` from artifact name, in order, to `{ files, rootDirectory }`. Ids count up from 1. `size` is the number of files. A second upload under a name throws `an artifact with this name already exists: <name>`, unless it overwrites. It reads no files.

`createTestPorts()` (the test fixture, [dagworkflows-workflows](dagworkflows-workflows.md)) gives a fresh memory cache store and memory artifact store unless given others, and returns them as `cacheStore` and `artifactStore`.

Where it lives: `packages/dagworkflows/src/ports.ts`, `src/ports/artifact-store.ts`, `src/ports/memory.ts`.

## Locally versus on GitHub

Who picks the stores ([dagworkflows-cli-action-release](dagworkflows-cli-action-release.md) owns the entry points):

| Where                                                             | Cache store                                                                                                                    | Artifact store                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| The action (`uses: …/dagworkflows/action`)                        | `createActionsCacheStore` when `@actions/cache`'s `isFeatureAvailable()` is true, else `nullCacheStore`                        | `createActionsArtifactStore` when `artifactServiceAvailable`, else `nullArtifactStore` |
| `dag run` / `dag post` with `GITHUB_ACTIONS=true` (a `run:` step) | `@actions/cache` only if `ACTIONS_CACHE_URL` or `ACTIONS_RESULTS_URL` is set and `isFeatureAvailable()`, else `nullCacheStore` | `@actions/artifact` only if `artifactServiceAvailable`, else `nullArtifactStore`       |
| `dag run` / `dag post` locally                                    | the worktree store                                                                                                             | `nullArtifactStore`, with no notice                                                    |

The runner hands a JavaScript action the cache service URL and runtime token. A `run:` step never sees them. So on GitHub the cache and artifacts work in the action, and are off in `dag run`. For CI, use the action. The repository's own `.github/workflows/ci.yml` runs `uses: ./packages/dagworkflows/action` with `workflow: scripts/ci.ts` for this reason.

When a service is off, a notice titled `dag` says so:

- The action: `actions/cache is off: no cache service in this environment` and `actions/upload-artifact is off: no artifact service in this environment`. Only its main entry sends them, so they come once per action step. Its post entry does not repeat them.
- `dag run` and `dag post` on GitHub: `actions/cache is off: this step cannot reach the cache service; use the action instead of \`dag run\``and`actions/upload-artifact is off: this step cannot reach the artifact service; use the action instead of \`dag run\``. Every such process sends its own, so a job with a `dag run`step and a`dag post`step gets them twice, and`dag post`also says "instead of`dag run`".

`@actions/cache` and `@actions/artifact` are optional peer dependencies. The action bundles them. `dag run` loads each one only on GitHub, and only when its service is reachable. So a `run:` step with no service needs neither installed. If one is needed and missing, the run fails with `dag needs @actions/cache on GitHub, an optional peer dependency it does not install: add it (npm install --save-dev @actions/cache), or use the action, which bundles it, instead of \`dag run\``(the same for`@actions/artifact`).

What differs for a workflow author:

- **Keys only matter on GitHub.** Locally the worktree store ignores them. The restore logs the key it asked for, and every save logs `Cache not saved with key: …`. Locally the run id is `0`, so a local partial key reads `<key>-partial-0`.
- **The local "cache" is the disk.** In the main checkout a restore always misses, and the CAS from last time is simply still there (`Kept, already there:`). A fresh worktree is filled from the main checkout.
- **Key validation is the toolkit's.** A bad key (a comma, say) fails the restore and save only where `createActionsCacheStore` is in use: the action, when the cache service is reachable. Locally, in a `run:` step on GitHub, or in any job with no cache service, the store is the worktree store or `nullCacheStore`, which never throw, and the bad key goes through unnoticed.
- **No artifacts locally.** Every upload logs `… not uploaded: no artifact service`, and `artifact.json` holds `null`.
- **`ctx.sha` and `ctx.ref` come from git locally** (see [dagworkflows-workflows](dagworkflows-workflows.md)). `sha` is the stdout of `git rev-parse HEAD`, taken even when that command fails. So in a repository with no commit, `sha` is the literal `HEAD` and a key like `ci-main-${sha}` reads `ci-main-HEAD`. Only with no git repository at all is `sha` `""`. A key like `ci-main-${sha}` then equals the restore key `ci-main-`, and the miss line reads `Cache not found for input keys: ci-main-, ci-main-`.

Where it lives: `packages/dagworkflows/src/services.ts`, `src/cli.ts`, `src/action/env.ts`, `src/action/main.ts`, `action/action.yml`.

## Things to get right when caching the CAS

- **`path` and `--cas-dir` must agree.** The cache's `path` is just a path. The run's CAS directory is the `--cas-dir` option (the action's `cas-dir` input), default `.dag/cas` (`DEFAULT_CAS_DIR`). If you change one, change the other.
- **Depend on the restore.** Only tasks with `deps: { cas: cas.restore }` are sure to start after the CAS is in place.
- **Save on one branch.** The repository saves only when `workflow.ctx.ref === "refs/heads/main"`, with a per-commit key and a shared prefix as restore key. Each main commit adds an entry, and every run restores the newest.
- **A key is written once.** A store never overwrites an entry. If a key's content must change, change the key, for example by putting `workflow.ctx.sha` or a `workflow.hash(...)` of the lockfile in it.
- **The CAS directory carries more than outputs.** The previous run's node durations are kept in `last-run.json` inside the CAS directory, so main's cache entry carries them ([dagworkflows-output](dagworkflows-output.md)). Node logs are written beside the CAS, under `<cas-dir>.logs/`, not inside it ([dagworkflows-output](dagworkflows-output.md)).

## Open questions

- `--only` on `main` saves under the full key once the selection is green, though only the selection ran. Since a key is written once, that entry stays for that commit even if a later full run on the same commit would have added more. The code and tests pin this as intended (`runner.test.ts`, "saves the CAS after lint alone"); whether docs should warn about it is open.
- A save that the cancel reaches while it is running reports `cancelled`, though the store may have saved the entry. A reader of the summary cannot tell.
- `createActionsArtifactStore` resolves `undefined` when the client returns no id, and the node then logs `not uploaded: no artifact service`, which names the wrong cause.
- A `path` that mixes globs and handles always gets the root `.` (see _Archive layout_), so the handle's file lands deep in the artifact, and a CAS outside the working directory fails the upload. A `path` of handles only does not have this problem. Whether the root should be computed from absolute paths is open.
- A file both matched by a glob and named by a handle is listed twice. Globs are deduplicated among themselves, not against handles, and a glob match is relative where a handle is absolute.
- The toolkit's own messages (`Cache restored successfully`, `Failed to save: …`, the 5xx error annotation) go to the job output through `@actions/core`, outside the node's log group. A 5xx on restore or save raises an error annotation although the node succeeds and the run can be green.
- Nodes cached on a fresh machine have no logs after a restore, because `<cas-dir>.logs/` is not under `.dag/cas` unless `path` lists it too. Each such hit shows an empty log group. Whether that is intended is for [dagworkflows-output](dagworkflows-output.md) to settle, and it lists the question among its own.
