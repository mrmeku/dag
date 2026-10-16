# Cache and artifacts

`w.restoreCache`, `w.saveCache` and `w.uploadArtifact` are the GitHub actions `actions/cache/restore`, `actions/cache/save` and `actions/upload-artifact`, as steps in the graph. They take the same inputs as these actions. They run each time, and dagactions never caches their results.

Without a GitHub cache or artifact service, for example on your laptop, these steps do nothing:

- Each restore misses.
- Each save does nothing.
- Each upload writes a line to the log and uploads nothing.

## actions/cache

`w.restoreCache` restores an entry, and `w.saveCache` saves it:

```typescript
const pnpm = w.restoreCache({
  name: "restore:pnpm",
  path: ["~/.local/share/pnpm/store"],
  key: `pnpm-${process.platform}-${await w.hash("pnpm-lock.yaml")}`,
  restoreKeys: [`pnpm-${process.platform}-`],
});
const install = w.run({
  name: "install",
  cmd: ["pnpm", "install"],
  deps: { pnpm },
  cacheable: false,
});
w.saveCache({ name: "save:pnpm", cache: pnpm, deps: { install: w.optional(install) } });
```

The restore tries `key` first. Then it tries each prefix in `restoreKeys` and takes the newest entry that matches.

The save is a post step. It does not save when the restore found an exact match, as `if: cache-hit != 'true'` does. If the cache service refuses the save, the step writes a warning. It does not fail.

Each step writes the value that `@actions/cache` returned, as JSON:

| Step    | File         | Content                                                                     |
| ------- | ------------ | --------------------------------------------------------------------------- |
| Restore | `cache.json` | The key that it restored, or `null`.                                        |
| Save    | `save.json`  | The ID of the entry, `-1` if it saved nothing, or `null` if it did not try. |

GitHub controls the match order, immutability, branch scope and quotas. See [Dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching).

### Cache the CAS

To use the results of the last run, restore and save `.dagactions/cas`. See [Keep the cache between GitHub runs](../README.md#keep-the-cache-between-github-runs).

> [!CAUTION]
> Cache `.dagactions/cas`, not all of `.dagactions`. The logs are in `.dagactions`, and a pull request from a fork can restore a cache entry. See [Secrets](secrets.md).

## actions/upload-artifact

`w.uploadArtifact` uploads files as an artifact of the run. `path` takes globs over the working tree and the outputs of dependencies. Thus a step can upload a build product directly from the CAS:

```typescript
const pack = w.run({
  name: "pack",
  cmd: ["npm", "pack", "--pack-destination", "$DAGACTIONS_OUT"],
  outputs: { tarball: "pkg-1.0.0.tgz" },
  deps: { install },
});
w.uploadArtifact({
  name: "upload:tarball",
  artifact: "tarball",
  path: [pack.outputs.tarball],
  deps: { pack },
});
w.uploadArtifact({
  name: "upload:junit",
  artifact: "junit",
  path: ["reports/**/*.xml"],
  deps: { tests: w.optional(tests) },
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

An artifact belongs to the run. Thus the step runs each time, and `deps` tells when. Use `w.optional` to upload a test report also when the tests fail.

The archive starts at the deepest directory that holds all files, as in `actions/upload-artifact`. Thus the outputs of one step are at the top of the archive. Outputs of more than one step keep their CAS paths.

These rules apply:

- If the service refuses the upload, the step fails.
- If the run already has an artifact with the same name, the service refuses it, unless `overwrite` is set. This can occur when you run a failed job again.
- The step needs no permission other than the runner's token.

`artifact.json` holds the `UploadArtifactResponse` of `@actions/artifact`: `id`, `size` and `digest`. It holds `{}` when the step uploaded nothing.

GitHub controls retention, size and storage quotas. See [Storing and sharing data from a workflow](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/storing-and-sharing-data-from-a-workflow).
