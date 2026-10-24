# Cache and artifacts

`workflow.cache` and `workflow.uploadArtifact` are the GitHub actions `actions/cache` and `actions/upload-artifact`, as tasks in the graph. They take the same inputs as these actions. Their tasks run each time, and dagworkflows never caches their results.

Without a GitHub cache or artifact service, for example on your laptop, these tasks do nothing:

- Each restore misses.
- Each save does nothing.
- Each upload writes a line to the log and uploads nothing.

## actions/cache

`workflow.cache` adds a task that restores an entry, and returns it as `restore`. Its `save` adds a task that saves the entry:

```typescript
const pnpm = workflow.cache({
  name: "pnpm",
  path: ["~/.local/share/pnpm/store"],
  key: `pnpm-${process.platform}-${await workflow.hash("pnpm-lock.yaml")}`,
  restoreKeys: [`pnpm-${process.platform}-`],
});
workflow.task({ name: "install", cmd: ["pnpm", "install"], deps: { pnpm: pnpm.restore } });
pnpm.save({ partial: "skip" });
```

`name` names the two tasks, `restore:pnpm` and `save:pnpm`. If you do not give a `name`, it is `cache`.

The restore tries `key` first, also as a prefix. Then it tries each prefix in `restoreKeys` and takes the newest entry that matches. It writes what it found to its log.

The restore has no outputs. Thus a hit and a miss give the tasks that depend on it the same cache key, and `deps: { pnpm: pnpm.restore }` does nothing but order `install` after the restore. No task can tell a hit from a miss. Work that must run only on a miss must check the files itself.

The save waits for every other task of the run, whatever that task did, so a task that you add later is never left out. It does not wait for post steps or for other saves, and no task depends on it. It is an ordinary task, not a post step: a cancellation stops it, and no later run owes it. To save at another point, write the save as your own task: an `action` that calls `ports.actionsCache.saveCache`, with the deps you choose.

`partial` tells what a run where a task did not succeed saves:

| `partial`          | A run where every task succeeded | A run where a task did not succeed                                                                  |
| ------------------ | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `"save"` (default) | Saves under `key`                | Saves what succeeded under `<key>-partial-<run id>`. The next restore finds it as a prefix of `key` |
| `"skip"`           | Saves under `key`                | Saves nothing, as `actions/cache` does with `post-if: success()`                                    |

Only a run where every task succeeded saves under `key`. GitHub never replaces an entry, so a failed run that took `key` would keep the next green run from saving. Use `"skip"` for a cache that a failed task can leave half written, such as a package store after a failed install. The CAS writes each entry completely or not at all, so `"save"` suits it.

The save runs each time, and dagworkflows never caches it. Before it saves, it asks the cache service if it has an entry for the key it saves under. It saves only if the service has none. Thus a second run saves nothing, and an entry that GitHub evicted is saved again. If the cache service refuses the save, the task writes a warning. It does not fail. An invalid key fails it.

The save writes the value that `@actions/cache` returned to `save.json`: the ID of the entry, or `-1` if the toolkit saved nothing. It writes `null` if it skipped a partial run, if the service already had the key, or if the service refused the save.

GitHub controls the match order, immutability, branch scope and quotas. See [Dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).

### Cache the CAS

To use the results of the last run, restore and save `.dag/cas`. See [Keep the cache between GitHub runs](../README.md#keep-the-cache-between-github-runs).

> [!CAUTION]
> Cache `.dag/cas`, not all of `.dag`. The logs are in `.dag`, and a pull request from a fork can restore a cache entry. See [Secrets](secrets.md).

## actions/upload-artifact

`workflow.uploadArtifact` uploads files as an artifact of the run. `path` takes globs over the working tree, or a function of the outputs of `deps` that names their files too, each its own item. The function gets each output as a file handle, as an `action` task does, when the upload runs. Thus a task can upload a build product directly from the CAS:

```typescript
const pack = workflow.task({
  name: "pack",
  cmd: ({ outputDir }) => ["npm", "pack", "--pack-destination", outputDir],
  outputs: { tarball: "pkg-1.0.0.tgz" },
  deps: { install },
});
workflow.uploadArtifact({
  name: "upload:tarball",
  artifact: "tarball",
  path: ({ pack }) => [pack.tarball],
  deps: { pack },
});
workflow.uploadArtifact({
  name: "upload:junit",
  artifact: "junit",
  path: ["reports/**/*.xml"],
  deps: { tests: settled(tests) },
  ifNoFilesFound: "ignore",
});
```

| Option           | Meaning                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `artifact`       | The name of the artifact. This is `name` in `actions/upload-artifact`. |
| `path`           | The files to upload.                                                   |
| `ifNoFilesFound` | What to do when `path` matches no file.                                |
| `overwrite`      | Replace an artifact with the same name.                                |
| `options`        | The `UploadArtifactOptions` of `@actions/artifact`.                    |

An artifact belongs to the run. Thus the task runs each time, and `deps` tells when. Use `settled` to upload a test report also when the tests fail: `deps: { tests: settled(tests) }, path: ({ tests }) => [tests?.report]`. When that dependency did not succeed, it is `undefined`, and the upload leaves out an `undefined` item.

The archive starts at the deepest directory that holds all files, as in `actions/upload-artifact`. Thus the outputs of one task are at the top of the archive. Outputs of more than one task keep their CAS paths.

These rules apply:

- If the service refuses the upload, the task fails.
- If the run already has an artifact with the same name, the service refuses it, unless `overwrite` is set. This can occur when you run a failed job again.
- The task needs no permission other than the runner's token.

`artifact.json` holds the `UploadArtifactResponse` of `@actions/artifact`: `id`, `size` and `digest`. It holds `{}` when the task uploaded nothing.

GitHub controls retention, size and storage quotas. See [Storing and sharing data from a workflow](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/storing-and-sharing-data-from-a-workflow).
