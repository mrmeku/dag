# Workflows

A workflow is a TypeScript file that default-exports `defineWorkflow`. Its `implementation` function adds steps to a graph. Each step declares three things:

- the steps that it needs (`deps`),
- the files that it reads (`inputs`),
- the files that it writes (`outputs`).

From these declarations, dagworkflows knows which steps can run in parallel and which steps can come from the cache.

## A complete example

```typescript
import { defineWorkflow } from "@mrmeku/dagworkflows";

export default defineWorkflow({
  schedulerOptions: { maxParallelism: 4, concurrencyLimits: { test: 2 } },
  implementation: async (workflow) => {
    const pnpm = workflow.restoreCache({
      name: "restore:pnpm",
      path: ["~/.local/share/pnpm/store"],
      key: `pnpm-${process.platform}-${await workflow.hash("pnpm-lock.yaml")}`,
      restoreKeys: [`pnpm-${process.platform}-`],
    });
    const install = workflow.run({
      name: "install",
      cmd: ["pnpm", "install"],
      deps: { pnpm },
      cacheable: false,
    });
    const src = await workflow.glob("src/**", "package.json", "tsconfig.json");
    const checks = workflow.runAll({
      typecheck: { cmd: ["pnpm", "typecheck"], inputs: src, deps: { install } },
      lint: { cmd: ["pnpm", "lint"], inputs: src, deps: { install } },
      test: { cmd: ["pnpm", "test"], inputs: src, deps: { install }, group: "test" },
    });
    workflow.requireAll({ deps: checks });
    workflow.saveCache({
      name: "save:pnpm",
      cache: pnpm,
      deps: { install: workflow.settled(install) },
    });
  },
});
```

The sections that follow explain each part of this example.

## Steps

`workflow` has one function for each type of step:

| Function                  | Step                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `workflow.run`            | Runs one command. A non-zero exit code fails the step.                                         |
| `workflow.runAll`         | Runs `workflow.run` for each entry of a record. The key of each entry is the name of the step. |
| `workflow.requireAll`     | Runs no command. It fails if one of its dependencies fails. Use it as one dependency for many. |
| `workflow.post`           | Runs a cleanup command after a main step. See [Lifecycle](lifecycle.md).                       |
| `workflow.restoreCache`   | Restores an `actions/cache` entry. See [Cache and artifacts](cache-and-artifacts.md).          |
| `workflow.saveCache`      | Saves an `actions/cache` entry.                                                                |
| `workflow.uploadArtifact` | Uploads an `actions/upload-artifact` artifact.                                                 |

`workflow.requireAll` names its step `require-all` unless you give it a `name`.

`cmd` is an array: the command and its arguments. dagworkflows does not use a shell. To use a shell, write `["sh", "-c", "..."]`.

## Dependencies

Each function returns a reference to its step. To make step B wait for step A, put the reference to A in the `deps` of B. This is the only way to order steps. Steps without a dependency between them start at the same time.

If a dependency fails, dagworkflows skips the dependent step. To run the dependent step also when the dependency fails, wrap the dependency in `workflow.settled`. This is the `if: always()` of a GitHub workflow:

```typescript
workflow.saveCache({
  name: "save:pnpm",
  cache: pnpm,
  deps: { install: workflow.settled(install) },
});
```

## Scheduler options

`schedulerOptions` controls how many steps run at the same time:

- `maxParallelism` is the maximum number of steps that run at the same time.
- `concurrencyLimits` gives a maximum for each named group.

A step joins a group with `group`. The group must be a key of `concurrencyLimits`. If it is not, the workflow does not compile.

## Inputs

`inputs` lists the files outside the graph that a step reads. Their content is part of the step's cache key. If a step reads a file that is not in `inputs`, a change to that file does not run the step again.

Use `workflow.glob` to make the list, and `workflow.hash` to hash files for a cache key:

- `workflow.glob(...patterns)` returns the files that the patterns match. It matches what the `path:` of `actions/cache` matches, hidden files included.
- `workflow.hash(...patterns)` returns the same hash as the `hashFiles()` expression, byte for byte.

Both functions are `@actions/glob`. Each call excludes the directories in `DEFAULT_EXCLUDES` (`src/config.ts`), for example `node_modules` and `.git`.

> [!WARNING]
> An exclusion removes files from the result, but `@actions/glob` still reads the excluded directory. Thus `**` reads all of `node_modules`, which can take 30 seconds. Start each pattern below the directories that you need, for example `src/**`.

## The cache key

The cache key of a step is a hash of these items:

- its command, `cwd` and `env`,
- its `config`,
- the path and the content of each file in `inputs`,
- the content of the outputs of each dependency, under its key in `deps`.

If the CAS has an entry for the key, the step does not run. dagworkflows uses the stored outputs. The order of `deps` and `inputs` does not change the key.

The step's name is not in the key: it is the step's address, for `--only`, the logs and the check runs. Thus a renamed step does not run again, and two steps that run the same command on the same inputs and dependencies share one entry, and one log.

If a step runs again but writes the same outputs, its dependents do not run again. Thus a change that does not change a step's outputs stops at that step.

These options change how a step uses the cache:

| Option              | Use it when                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `config`            | The result depends on something that no file shows, for example the version of a tool. Change the value to run the step again. |
| `cacheable: false`  | The step must run each time, for example an install on a new runner or an integration test. Its outputs are still hashed.      |
| `invalidateOn`      | The step reads only part of a dependency's outputs. Give a function that returns the part that the step reads.                 |
| `--force` (the CLI) | You want to ignore the cache for one run.                                                                                      |

A constant `invalidateOn` function orders a step after a dependency but keeps that dependency out of the key. Use this for a cache restore:

```typescript
workflow.run({
  name: "lint",
  cmd: ["pnpm", "lint"],
  deps: { cas },
  invalidateOn: { cas: () => "" },
});
```

## Outputs

A step writes its output files to the directory in `$DAG_OUT`, and declares them by name in `outputs`. If a declared file is missing, the step fails.

Another step refers to an output as `pack.outputs.tarball`. This is the `steps.pack.outputs.tarball` of a GitHub workflow. Use the reference in a command argument or in an `env` value:

```typescript
const pack = workflow.run({
  name: "pack",
  cmd: ["npm", "pack", "--pack-destination", "$DAG_OUT"],
  outputs: { tarball: "pkg-1.0.0.tgz" },
});
workflow.run({ name: "publish", cmd: ["npm", "publish", pack.outputs.tarball], deps: { pack } });
```

When the command runs, the reference becomes the path of the file in the CAS. These rules apply:

- The step that refers to an output must have the step that writes it in `deps`. If it does not, the workflow does not build.
- The cache key holds the reference as the dependency's key in `deps` and the output's name, never the path or the name of the step that writes it. Thus renaming `pack` does not run `publish` again.
- If the dependency is settled and it failed, a reference that is a whole argument becomes the empty string, as on GitHub. A reference inside a template string fails the step instead, because `${pack.outputs.dir}/tmp` would become `/tmp`.

## The actions toolkit

dagworkflows uses the [actions toolkit](https://github.com/actions/toolkit). It does not make its own copy of it:

| Package             | Use in dagworkflows                               |
| ------------------- | ------------------------------------------------- |
| `@actions/core`     | Log groups, annotations and the step summary.     |
| `@actions/github`   | The run's context and the check runs.             |
| `@actions/cache`    | `workflow.restoreCache` and `workflow.saveCache`. |
| `@actions/artifact` | `workflow.uploadArtifact`.                        |
| `@actions/glob`     | `workflow.glob` and `workflow.hash`.              |

Each JSON output of a step holds the value that the toolkit returned, without changes.

Only `@actions/glob` is a dependency. The other packages are optional peer dependencies: the action bundles them, and `dag run` in a `run:` step needs `@actions/core` and `@actions/github`. Importing `@mrmeku/dagworkflows` loads none of them; the GitHub adapter, `createGithubHost`, is the subpath `@mrmeku/dagworkflows/github`. A typecheck needs none of them either: the published declarations hold the toolkit's types.
