# Workflows

A workflow is a TypeScript file that default-exports `defineWorkflow`. Its `build` function adds steps to a graph. Each step declares three things:

- the steps that it needs (`deps`),
- the files that it reads (`inputs`),
- the files that it writes (`outputs`).

From these declarations, dagactions knows which steps can run in parallel and which steps can come from the cache.

## A complete example

```typescript
import { defineWorkflow } from "@mrmeku/dagactions";

export default defineWorkflow({
  limits: { maxParallelism: 4, concurrencyLimits: { test: 2 } },
  build: async (w) => {
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
    const src = await w.glob("src/**", "package.json", "tsconfig.json");
    const checks = w.runAll({
      typecheck: { cmd: ["pnpm", "typecheck"], inputs: src, deps: { install } },
      lint: { cmd: ["pnpm", "lint"], inputs: src, deps: { install } },
      test: { cmd: ["pnpm", "test"], inputs: src, deps: { install }, group: "test" },
    });
    w.gate({ deps: checks });
    w.saveCache({ name: "save:pnpm", cache: pnpm, deps: { install: w.optional(install) } });
  },
});
```

The sections that follow explain each part of this example.

## Steps

`w` has one function for each type of step:

| Function           | Step                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `w.run`            | Runs one command. A non-zero exit code fails the step.                                         |
| `w.runAll`         | Runs `w.run` for each entry of a record. The key of each entry is the name of the step.        |
| `w.gate`           | Runs no command. It fails if one of its dependencies fails. Use it as one dependency for many. |
| `w.post`           | Runs a cleanup command after a main step. See [Lifecycle](lifecycle.md).                       |
| `w.restoreCache`   | Restores an `actions/cache` entry. See [Cache and artifacts](cache-and-artifacts.md).          |
| `w.saveCache`      | Saves an `actions/cache` entry.                                                                |
| `w.uploadArtifact` | Uploads an `actions/upload-artifact` artifact.                                                 |

`cmd` is an array: the command and its arguments. dagactions does not use a shell. To use a shell, write `["sh", "-c", "..."]`.

## Dependencies

Each function returns a reference to its step. To make step B wait for step A, put the reference to A in the `deps` of B. This is the only way to order steps. Steps without a dependency between them start at the same time.

If a dependency fails, dagactions skips the dependent step. To run the dependent step also when the dependency fails, wrap the dependency in `w.optional`. This is the `if: always()` of a GitHub workflow:

```typescript
w.saveCache({ name: "save:pnpm", cache: pnpm, deps: { install: w.optional(install) } });
```

## Limits

`limits` controls how many steps run at the same time:

- `maxParallelism` is the maximum number of steps that run at the same time.
- `concurrencyLimits` gives a maximum for each named group.

A step joins a group with `group`. The group must be a key of `concurrencyLimits`. If it is not, the workflow does not compile.

## Inputs

`inputs` lists the files outside the graph that a step reads. Their content is part of the step's cache key. If a step reads a file that is not in `inputs`, a change to that file does not run the step again.

Use `w.glob` to make the list, and `w.hash` to hash files for a cache key:

- `w.glob(...patterns)` returns the files that the patterns match. It matches what the `path:` of `actions/cache` matches, hidden files included.
- `w.hash(...patterns)` returns the same hash as the `hashFiles()` expression, byte for byte.

Both functions are `@actions/glob`. Each call excludes the directories in `DEFAULT_EXCLUDES` (`src/config.ts`), for example `node_modules` and `.git`.

> [!WARNING]
> An exclusion removes files from the result, but `@actions/glob` still reads the excluded directory. Thus `**` reads all of `node_modules`, which can take 30 seconds. Start each pattern below the directories that you need, for example `src/**`.

## The cache key

The cache key of a step is a hash of these items:

- the step's name,
- its command, `cwd` and `env`,
- its `config`,
- the content of each file in `inputs`,
- the content of the outputs of each dependency.

If the CAS has an entry for the key, the step does not run. dagactions uses the stored outputs. The order of `deps` and `inputs` does not change the key.

If a step runs again but writes the same outputs, its dependents do not run again. Thus a change that does not change a step's outputs stops at that step.

These options change how a step uses the cache:

| Option              | Use it when                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `config`            | The result depends on something that no file shows, for example the version of a tool. Change the value to run the step again. |
| `cacheable: false`  | The step must run each time, for example an install on a new runner or an integration test. Its outputs are still hashed.      |
| `normalize`         | The step reads only part of a dependency's outputs. Give a function that returns the part that the step reads.                 |
| `--force` (the CLI) | You want to ignore the cache for one run.                                                                                      |

A constant `normalize` function orders a step after a dependency but keeps that dependency out of the key. Use this for a cache restore:

```typescript
w.run({ name: "lint", cmd: ["pnpm", "lint"], deps: { cas }, normalize: { cas: () => "" } });
```

## Outputs

A step writes its output files to the directory in `$DAGACTIONS_OUT`, and declares them by name in `outputs`. If a declared file is missing, the step fails.

Another step refers to an output as `pack.outputs.tarball`. This is the `steps.pack.outputs.tarball` of a GitHub workflow. Use the reference in a command argument or in an `env` value:

```typescript
const pack = w.run({
  name: "pack",
  cmd: ["npm", "pack", "--pack-destination", "$DAGACTIONS_OUT"],
  outputs: { tarball: "pkg-1.0.0.tgz" },
});
w.run({ name: "publish", cmd: ["npm", "publish", pack.outputs.tarball], deps: { pack } });
```

When the command runs, the reference becomes the path of the file in the CAS. These rules apply:

- The step that refers to an output must have the step that writes it in `deps`. If it does not, the workflow does not build.
- If the dependency is optional and it failed, the reference becomes the empty string, as on GitHub.

## The actions toolkit

dagactions uses the [actions toolkit](https://github.com/actions/toolkit). It does not make its own copy of it:

| Package             | Use in dagactions                             |
| ------------------- | --------------------------------------------- |
| `@actions/core`     | Log groups, annotations and the step summary. |
| `@actions/github`   | The run's context and the check runs.         |
| `@actions/cache`    | `w.restoreCache` and `w.saveCache`.           |
| `@actions/artifact` | `w.uploadArtifact`.                           |
| `@actions/glob`     | `w.glob` and `w.hash`.                        |

Each JSON output of a step holds the value that the toolkit returned, without changes.
