# Workflows

A workflow is a TypeScript file that default-exports `defineWorkflow`. Its `implementation` function adds tasks to a graph through the facade, `workflow`. Each task declares three things:

- the tasks that it needs (`deps`),
- what it reads from outside the graph (`inputs`),
- the files that it writes (`outputs`).

From these declarations, dagworkflows knows which tasks can run in parallel and which tasks can come from the cache.

## A complete example

```typescript
import { defineWorkflow, settled } from "@mrmeku/dagworkflows";

export default defineWorkflow({
  schedulerOptions: { maxParallelism: 4, concurrencyLimits: { test: 2 } },
  implementation: async (workflow) => {
    const pnpm = workflow.restoreCache({
      name: "restore:pnpm",
      path: ["~/.local/share/pnpm/store"],
      key: `pnpm-${process.platform}-${await workflow.hash("pnpm-lock.yaml")}`,
      restoreKeys: [`pnpm-${process.platform}-`],
    });
    const install = workflow.run({ name: "install", cmd: ["pnpm", "install"], deps: { pnpm } });
    const src = await workflow.glob("src/**", "package.json", "tsconfig.json");
    const typecheck = workflow.run({
      name: "typecheck",
      cmd: ["pnpm", "typecheck"],
      inputs: src,
      deps: { install },
    });
    const lint = workflow.run({
      name: "lint",
      cmd: ["pnpm", "lint"],
      inputs: src,
      deps: { install },
    });
    const test = workflow.run({
      name: "test",
      cmd: ["pnpm", "test"],
      inputs: src,
      deps: { install },
      concurrencyGroup: "test",
    });
    workflow.requireAll({ deps: { typecheck, lint, test } });
    workflow.saveCache({ name: "save:pnpm", cache: pnpm, deps: { install: settled(install) } });
  },
});
```

The sections that follow explain each part of this example.

## Tasks

Each node of the graph is a task. `workflow.task` adds a task whose work is a TypeScript function. The other functions are conveniences: each adds tasks for a common case.

| Function                  | Adds                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `workflow.task`           | A task whose work is a TypeScript function, as `actions/github-script` runs one.              |
| `workflow.run`            | A task that runs one program, with no shell. A non-zero exit code fails it.                   |
| `workflow.runShell`       | A task that runs a string under bash, as a `run:` step of a GitHub workflow does.             |
| `workflow.requireAll`     | A task that runs no command. It fails if one of its dependencies fails. Use it for many deps. |
| `workflow.post`           | A command that cleans up after a main task. See [Lifecycle](lifecycle.md).                    |
| `workflow.restoreCache`   | A restore of an `actions/cache` entry. See [Cache and artifacts](cache-and-artifacts.md).     |
| `workflow.saveCache`      | A save of an `actions/cache` entry.                                                           |
| `workflow.uploadArtifact` | An upload of an `actions/upload-artifact` artifact.                                           |

`workflow.requireAll` names its task `require-all` unless you give it a `name`. To add many tasks of one shape, call a function in a loop.

### Commands: `workflow.run` and `workflow.runShell`

`workflow.run` runs one program. `cmd` is a list: the program and its arguments. No shell runs it, and nothing in it is expanded.

`workflow.runShell` runs `cmd`, one string, under `bash --noprofile --norc -eo pipefail -c`. This is GitHub's `shell: bash`:

- The first command that fails stops the string and fails the task.
- A pipe fails when one of its commands fails: `npm test | tee test.log` fails when the tests fail.
- The user's shell configuration stays out.
- A machine without bash fails the task. dagworkflows never uses `sh` instead.

```typescript
workflow.run({ name: "lint", cmd: ["bun", "run", "lint"], inputs: await workflow.glob("src/**") });
workflow.runShell({ name: "smoke", cmd: "curl -fsS localhost:4000/health | grep -q ok" });
```

Both commands take these fields:

| Field              | Meaning                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `name`             | The task's name. It is unique in the graph, and it is not part of the cache key.                 |
| `cmd`              | A list for `run`, a string for `runShell`. `run` also takes a function. See [Outputs](#outputs). |
| `deps`             | The tasks that it needs, by role.                                                                |
| `inputs`           | What it reads from outside the graph. See [Inputs](#inputs).                                     |
| `outputs`          | The files that it writes to its output directory, by role.                                       |
| `cwd`              | The directory that it runs in, from the repository root.                                         |
| `env`              | Variables set over the environment that it inherits. A record, or a function.                    |
| `cacheable`        | `true` or `false`. See [When a task runs](#when-a-task-runs).                                    |
| `concurrencyGroup` | A group of `concurrencyLimits`.                                                                  |
| `timeoutMs`        | The time that it can run, in milliseconds. See [Lifecycle](lifecycle.md#timeouts).               |
| `invalidateOn`     | For a dependency that it reads only in part, that part. See [The cache key](#the-cache-key).     |

A command gets the whole environment of the process. Its `env` sets variables over it.

### `workflow.task`

A task's `action` is a TypeScript function:

```typescript
const notes = workflow.task({
  name: "release-notes",
  deps: { pack },
  inputs: { version: "release-notes-v1", changelog: file("CHANGELOG.md") },
  outputs: { notes: "notes.md" },
  action: async ({ inputs, depOutputs, out, ports, run }) => {
    const files = await run(["tar", "-tzf", depOutputs.pack.tarball.path]);
    const changes = await inputs.changelog.text();
    await ports.fs.writeText(out.notes, `${changes}\n\n${files}`);
  },
});
```

The function receives these values:

| Value                    | What it is                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `inputs`                 | Each input by name: a file as a handle, a value as written.                                                                            |
| `depOutputs`             | The outputs of each dependency, by role, as handles: `path`, `text()` and `json(is)`. A settled dependency that failed is `undefined`. |
| `out`                    | Each declared output, by role, as its absolute path in `outputDir`. Write each one before you return.                                  |
| `outputDir`              | A new, empty directory for this attempt, as an absolute path.                                                                          |
| `ports`                  | The run's ports, as `workflow.ports`.                                                                                                  |
| `signal`                 | Fires when the task times out or the run is cancelled.                                                                                 |
| `run(argv, options)`     | Runs a program with no shell. It returns what the program writes to stdout.                                                            |
| `runShell(cmd, options)` | Runs a string as `workflow.runShell` does. It returns what the string writes to stdout.                                                |
| `log(line)`              | Writes a line to the task's log.                                                                                                       |
| `warn(message)`          | Writes a GitHub warning to the task's log, with the task's name as its title.                                                          |

`run` and `runShell` take a `cwd`, and an `env` that is set over the inherited environment, where `undefined` removes a variable. A handle's `path`, `out` and `outputDir` are absolute, so a command with its own `cwd` finds them. They write the command's output to the task's log, and they throw when the command exits with a non-zero code. A path goes into a shell string only through `env`: `runShell('tar -tzf "$TARBALL"', { env: { TARBALL: path } })`.

If the function throws an error, the task fails with that error. If a declared output is missing when the function returns, the task fails.

The function is not part of the cache key. Thus each value that the function reads must be in `inputs`, and the function reads it back from there. Give a task a version input, and change it when you change the function. See [The cache key](#the-cache-key).

## Dependencies

Each function returns a reference to its task. To make task B wait for task A, put the reference to A in the `deps` of B. This is the only way to order tasks. Tasks without a dependency between them start at the same time.

If a dependency fails, dagworkflows skips the dependent task. To run the dependent task also when the dependency fails, wrap the dependency in `settled`. This is the `if: always()` of a GitHub workflow:

```typescript
import { settled } from "@mrmeku/dagworkflows";

workflow.saveCache({ name: "save:pnpm", cache: pnpm, deps: { install: settled(install) } });
```

## Scheduler options

`schedulerOptions` controls how many tasks run at the same time:

- `maxParallelism` is the maximum number of tasks that run at the same time.
- `concurrencyLimits` gives a maximum for each named group.

A task joins a group with `concurrencyGroup`. The group must be a key of `concurrencyLimits`. If it is not, the workflow does not compile.

## Inputs

`inputs` is a record of what a task reads from outside the graph, by name. Each input is part of the task's cache key:

| Input   | Example                        | The task reads | The key holds                        |
| ------- | ------------------------------ | -------------- | ------------------------------------ |
| A file  | `file("bun.lock")`             | a handle       | its path and the hash of its content |
| A value | `"lint-v1"`, `{ os: "linux" }` | the value      | the value as JSON                    |

`file` and `settled` are exports of `@mrmeku/dagworkflows`. A file input is its own input, and it is never part of a string, as refs are not. `` `--config=${file("eslint.config.ts")}` `` does not compile, and its conversion to a string throws.

An environment variable that decides a task's output is a value input, read while the graph is built: `inputs: { mixEnv: workflow.ports.env.MIX_ENV ?? null }`. An unset variable is then `null`, apart from an empty one. The input does not change what a command receives: a command inherits the whole environment.

If a task reads something that is not in `inputs`, a change to it does not run the task again.

Use `workflow.glob` to declare many files, and `workflow.hash` to hash files for a cache key:

- `workflow.glob(...patterns)` returns a `file()` input for each file that the patterns match, named by its path. Spread it into `inputs`: `inputs: { version: "v1", ...(await workflow.glob("src/**")) }`. It matches what the `path:` of `actions/cache` matches, hidden files included.
- `workflow.hash(...patterns)` returns the same hash as the `hashFiles()` expression, byte for byte. It gives the patterns to `hashFiles()` as they are.

Both functions are `@actions/glob`. Only `workflow.glob` excludes the directories in `DEFAULT_EXCLUDES`: `.git`, `node_modules` and `.dag`. To exclude another directory, add a negated pattern, such as `!dist/**`.

> [!WARNING]
> An exclusion removes files from the result, but `@actions/glob` still reads the excluded directory. Thus `**` reads all of `node_modules`, which can take 30 seconds. Start each pattern below the directories that you need, for example `src/**`.

Two input names are taken. A task keys its declared outputs under `declaredOutputs`, and a command keys its `cmd`, `cwd` and `env` under `command`. Thus no task's `inputs` can use the first name, and no command's `inputs` the second.

## When a task runs

A task that declares no inputs runs each time, as a GitHub step does. A task whose `inputs` is not empty comes from the cache when its key did not change. `cacheable` changes this:

| `cacheable` | The task                                                                           |
| ----------- | ---------------------------------------------------------------------------------- |
| not given   | Comes from the cache if it declares inputs. Else it runs each time.                |
| `true`      | Comes from the cache when its key did not change, also with no inputs.             |
| `false`     | Runs each time. Use it for an install on a new runner, or for an integration test. |

A command's own `cmd`, `cwd` and `env` are part of its key, but they do not count as inputs. Thus a glob that matches no file gives a task that runs each time.

A receipt is a side effect that a run again must skip, such as an `npm publish`. It declares `cacheable: true`, so the same tarball does not publish twice:

```typescript
workflow.run({
  name: "publish",
  deps: { pack },
  cmd: ({ pack }) => ["npm", "publish", pack.tarball],
  cacheable: true,
});
```

> [!IMPORTANT]
> A failed task writes nothing that another task can read. To upload a report after a failure, write it to the working tree and upload it with a glob. A command that writes the working tree for another task to read, as `bun install` writes `node_modules`, must run each time: give it no inputs, as `install` above, or `cacheable: false` beside them.

## The cache key

The cache key of a task is a hash of these items:

- each input, by name,
- for a command, its `cmd`, `cwd` and `env`,
- the role and file name of each declared output,
- the content of the outputs of each dependency, by its role in `deps`.

If the CAS has an entry for the key, the task does not run. dagworkflows uses the stored outputs. The order of `deps` and `inputs` does not change the key.

The task's name is not in the key: it is the task's address, for `--only`, the logs and the check runs. Thus a renamed task does not run again, and two commands that run the same command on the same inputs and dependencies share one entry, and one log.

A task's function is not in its key. Thus dagworkflows refuses two cached tasks that declare the same inputs, the same dependencies in the same roles, the same outputs and `invalidateOn` for the same roles, but two action functions. Two `invalidateOn` functions count as one, since they can return the same string. The second one would get the first one's result for work that never ran. This occurs when a loop adds tasks and the function reads the loop's variable. Put the variable in `inputs`:

```typescript
for (const os of ["linux", "macos"]) {
  workflow.task({
    name: `manifest:${os}`,
    inputs: { version: "manifest-v1", os },
    outputs: { manifest: "manifest.json" },
    action: async ({ inputs, out, ports }) => {
      await ports.fs.writeText(out.manifest, JSON.stringify({ os: inputs.os }));
    },
  });
}
```

Tasks that share one function object do the same work. They can declare the same, and share one entry: two identical commands do this.

If a task runs again but writes the same outputs, its dependents do not run again. Thus a change that does not change a task's outputs stops at that task.

These options change how a task uses the cache:

| Option              | Use it when                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| a version input     | The result depends on the task's own logic. Change the value, for example to `"lint-v2"`, to run the task again. |
| `cacheable`         | The default is not correct for the task. See [When a task runs](#when-a-task-runs).                              |
| `invalidateOn`      | The task reads only part of a dependency's outputs. Give a function that returns the part that the task reads.   |
| `--force` (the CLI) | You want to ignore the cache for one run.                                                                        |

A constant `invalidateOn` function orders a task after a dependency but keeps that dependency out of the key. Use this for a cache restore:

```typescript
workflow.run({
  name: "lint",
  cmd: ["pnpm", "lint"],
  inputs: src,
  deps: { cas },
  invalidateOn: { cas: () => "" },
});
```

## Outputs

A command writes its output files to its output directory, and declares them by role in `outputs`. If a declared file is missing, the command fails.

A command names a path only through a function. `cmd` and `env` can each be a function of the dependencies that the command declares, each with its outputs, and of its own `out` and `outputDir`:

```typescript
const pack = workflow.run({
  name: "pack",
  cmd: ({ outputDir }) => ["npm", "pack", "--pack-destination", outputDir],
  outputs: { tarball: "pkg-1.0.0.tgz" },
});
workflow.run({ name: "list", deps: { pack }, cmd: ({ pack }) => ["tar", "-tzf", pack.tarball] });
workflow.runShell({
  name: "size",
  deps: { pack },
  cmd: 'gzip -c "$TARBALL" | wc -c',
  env: ({ pack }) => ({ TARBALL: pack.tarball }),
});
```

Each value that the function receives is a ref, as `steps.pack.outputs.tarball` is in a GitHub workflow. When the command starts, a ref becomes the absolute path of the file. Thus a command with its own `cwd` sees the same file. These rules apply:

- A ref is never part of a string: it is its own argument or its own `env` value. A ref in a template string or with `+` does not compile. A shell string reads the ref from `env`, quoted: `"$TARBALL"`.
- A command names an output only through the dependencies that it declares, and a ref goes only in what the call that received it returns. Thus TypeScript refuses a dependency that is not in `deps`, a misspelt output, and a ref or an `out` kept from another command's function.
- A settled dependency's output may be missing. It is only an `env` value. When the dependency did not succeed, the variable is unset, also when the command would inherit it. A shell string tests it: `if [ -n "$REPORT" ]; then cat "$REPORT"; fi`.
- `out` holds the command's own outputs, and `outputDir` its output directory. A dependency cannot take the role `out` or `outputDir`.
- An output that holds a list of paths becomes the absolute paths, joined with `:`.
- A dependency that can be `undefined`, as in `deps: { pack: release ? pack : undefined }`, gives a record that can be `undefined`. Check it before you use it.
- The cache key holds a ref as the dependency's role and the output's name, never the path or the name of the task that writes it. Thus renaming `pack` does not run `list` again.

A task's function reads its dependencies' files from `depOutputs`, as handles, and writes its own outputs to `out`.

## Composing workflows

`workflow.compose(other)` puts another workflow into this one. It calls the other workflow's implementation with this workflow's graph, and returns what that implementation returns:

```typescript
import checks from "./checks.ts";

export default defineWorkflow({
  schedulerOptions: { concurrencyLimits: { test: 2 } },
  implementation: async (workflow) => {
    const { lint, test } = await workflow.compose(checks);
    workflow.requireAll({ deps: { lint, test } });
  },
});
```

The other workflow's `schedulerOptions` do not apply. Each concurrency group that it declares must be in this workflow's `schedulerOptions`, or the workflow does not compile. A helper that adds tasks can also be a plain function of `workflow`.

## The actions toolkit

dagworkflows uses the [actions toolkit](https://github.com/actions/toolkit). It does not make its own copy of it:

| Package             | Use in dagworkflows                               |
| ------------------- | ------------------------------------------------- |
| `@actions/core`     | Log groups, annotations and the step summary.     |
| `@actions/github`   | The run's context and the check runs.             |
| `@actions/cache`    | `workflow.restoreCache` and `workflow.saveCache`. |
| `@actions/artifact` | `workflow.uploadArtifact`.                        |
| `@actions/glob`     | `workflow.glob` and `workflow.hash`.              |

Each JSON output of a cache or artifact task holds the value that the toolkit returned, without changes.

Only `@actions/glob` is a dependency. The other packages are optional peer dependencies: the action bundles them, and `dag run` in a `run:` step needs `@actions/core` and `@actions/github`. Importing `@mrmeku/dagworkflows` loads none of them; the GitHub adapter, `createGithubHost`, is the subpath `@mrmeku/dagworkflows/github`. A typecheck needs none of them either: the published declarations hold the toolkit's types.
