<div align="center">

# dagworkflows

**Run a GitHub Actions job as a graph of cached tasks, on GitHub and on your laptop.**

[![npm](https://img.shields.io/npm/v/@mrmeku/dagworkflows.svg)](https://www.npmjs.com/package/@mrmeku/dagworkflows)
[![CI](https://github.com/mrmeku/dag/actions/workflows/ci.yml/badge.svg)](https://github.com/mrmeku/dag/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/@mrmeku/dagworkflows.svg)](https://github.com/mrmeku/dag/blob/main/LICENSE)

<img src="https://raw.githubusercontent.com/mrmeku/dag/main/packages/dagworkflows/docs/media/demo.gif" width="720" alt="Two runs of npx --no dag run scripts/ci.ts. In the first run, six tasks run and lint fails. In the second run, three tasks come from the cache; install and build, which are never cached, and lint run again.">

</div>

## Why dagworkflows

dagworkflows makes a CI job faster, and it makes a failure easier to fix. A GitHub Actions job runs its steps in sequence, and it runs all of them on each push. dagworkflows runs the job as a graph of tasks instead, which changes this in three ways:

- **Tasks run in parallel.** Each task declares the tasks that it needs. dagworkflows starts all other tasks immediately, within the limits that you set.
- **Unchanged tasks do not run.** Each task declares the files that it reads. If these files and the task's dependencies did not change, dagworkflows uses the result from the cache.
- **The same file runs on your laptop.** `npx --no dag run` shows the job live in your terminal. For each failure, it shows the log, the command, and the command that runs the task again.

## Contents

- [Quick start](#quick-start)
- [Features](#features)
- [How it works](#how-it-works)
- [Output](#output)
- [Compared to other tools](#compared-to-other-tools)
- [Documentation](#documentation)

## Quick start

1. Install the package. You must have Node 24.2 or later.

   ```sh
   npm install --save-dev @mrmeku/dagworkflows
   ```

2. Write the workflow in `scripts/ci.ts`:

   ```typescript
   import { defineWorkflow } from "@mrmeku/dagworkflows";

   export default defineWorkflow({
     implementation: async (workflow) => {
       const src = await workflow.glob("src/**", "package.json", "tsconfig.json");
       workflow.task({ name: "typecheck", cmd: ["npx", "tsc", "--noEmit"], inputs: src });
       workflow.task({ name: "lint", cmd: ["npx", "eslint", "src"], inputs: src });
       workflow.task({ name: "test", cmd: ["npm", "test"], inputs: src });
     },
   });
   ```

   Each `workflow.task` with a `cmd` adds a task that runs one command. These tasks have no dependencies, so they start at the same time. `inputs` holds the files that a task reads.

3. Run the workflow locally:

   ```sh
   npx --no dag run scripts/ci.ts
   ```

4. Run the workflow again. All three tasks come from the cache. Then edit `README.md` and run it again. No task runs, because no task reads `README.md`.

5. Add the workflow to `.github/workflows/ci.yml`:

   ```yaml
   jobs:
     ci:
       runs-on: ubuntu-latest
       permissions:
         contents: read
         checks: write
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 24
         - run: npm ci
         - uses: mrmeku/dagworkflows@v0
           with:
             workflow: scripts/ci.ts
           env:
             GITHUB_TOKEN: ${{ github.token }}
   ```

   `checks: write` and `GITHUB_TOKEN` are optional. With them, each task shows as a check run on the pull request.

### Keep the cache between GitHub runs

Each GitHub runner starts with an empty cache. To use the results of the last run, restore the cache before the checks and save it after them. Both operations are tasks in the graph:

```typescript
import { defineWorkflow } from "@mrmeku/dagworkflows";

export default defineWorkflow({
  implementation: async (workflow) => {
    const cas = workflow.restoreCache({
      name: "restore:cas",
      path: [".dag/cas"],
      key: `dag-${workflow.ctx.sha}`,
      restoreKeys: ["dag-"],
    });
    const afterRestore = { deps: { cas }, invalidateOn: { cas: () => "" } };
    const src = await workflow.glob("src/**", "package.json", "tsconfig.json");
    const check = (name: string, cmd: string[]) =>
      workflow.task({ name, cmd, inputs: src, ...afterRestore });
    workflow.requireAll({
      deps: {
        typecheck: check("typecheck", ["npx", "tsc", "--noEmit"]),
        lint: check("lint", ["npx", "eslint", "src"]),
        test: check("test", ["npm", "test"]),
      },
    });
    workflow.saveCache({ name: "save:cas", cache: cas });
  },
});
```

- `deps: { cas }` starts each check after the restore.
- `invalidateOn: { cas: () => "" }` keeps the restored key out of the cache key of each check.
- The save is a post step of the restore. It waits for each task that depends on the restore, directly or through other tasks, and it saves also when a check fails.

## Features

- **A graph of tasks.** Tasks declare their dependencies. Independent tasks run in parallel, with a limit for the run and for each group. A task's work is a command (`cmd`), a bash string (`shell`) or a TypeScript function (`action`). [Workflows](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/workflows.md)
- **A content-addressed cache.** A task runs again only when its command, its inputs, or the outputs of its dependencies change, or when a TypeScript task gets a new name. A task that declares no inputs runs each time, as a GitHub step does. [The cache key](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/workflows.md#the-cache-key)
- **Files between tasks.** A task writes output files, and other tasks read them through the dependencies that they declare. [Outputs](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/workflows.md#outputs)
- **GitHub's cache and artifacts as tasks.** `workflow.restoreCache`, `workflow.saveCache` and `workflow.uploadArtifact` are `actions/cache` and `actions/upload-artifact`. [Cache and artifacts](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/cache-and-artifacts.md)
- **GitHub's job lifecycle.** Post steps, timeouts and cancellation behave as they do on GitHub. [Lifecycle](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/lifecycle.md)
- **Output for each reader.** A live view in a terminal, a short report for an AI agent, and log groups, check runs and a step summary on GitHub. [Output](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/output.md)
- **Secrets stay out of the cache.** Commands see secrets only through the environment, and dagworkflows masks them as GitHub does. [Secrets](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/secrets.md)
- **Built on the actions toolkit.** `workflow.hash` is the `hashFiles()` expression, byte for byte. `workflow.glob` matches what the `path:` of `actions/cache` matches, less `.git`, `node_modules` and `.dag`.

## How it works

dagworkflows runs a graph of tasks, and it caches the result of each task by the content of what the task reads. The graph engine is [`@mrmeku/dagraph`](https://github.com/mrmeku/dag/tree/main/packages/dagraph). Each task is one node of the engine's graph.

| Term       | Meaning                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Task       | One node: a TypeScript function. A command or a GitHub operation, such as a cache restore, is a task too.                    |
| Dependency | A task that must finish before another task starts. Declare it in `deps`.                                                    |
| Input      | Something outside the graph that a task reads: a file, or a value such as an environment variable's. Declare it in `inputs`. |
| Output     | A file that a task writes to its output directory. Other tasks read it through their `deps`.                                 |
| CAS        | The content-addressed store in `.dag/cas`. It holds the outputs of each task, by cache key.                                  |
| Cache key  | A hash of the task's kind, its inputs, its command and `env`, and the content of its dependencies' outputs.                  |

Before a task runs, dagworkflows calculates its cache key. If the CAS has an entry for the key, the task does not run. dagworkflows uses the stored outputs.

If a task runs again but writes the same outputs, its dependents do not run again. Thus a change that does not change a task's outputs stops at that task.

## Output

dagworkflows shows each run in the format that its reader needs. It selects the format from where it runs:

| Where it runs  | What it shows                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| A terminal     | One line for each task that finishes, a block for each failure, and a live footer with the tasks that run now. |
| An AI agent    | Only the failures and a recap, in plain text, in approximately 10,000 characters.                              |
| A pipe or CI   | The full log of each task, in groups, as GitHub shows it.                                                      |
| GitHub Actions | A log group, an annotation and a check run for each task, and a step summary with a timeline and the graph.    |

Each local run also writes the log of each task to `.dag/logs/` and a report of the failures to `.dag/failures.md`. Give this report to a person or an agent that must fix the failures.

Each run ends with a recap. The recap names the task that caused the failure, and the command that runs that task again:

```
✖ test:unit failed · scripts/ci.ts · built 1 · cached 4 · failed 2 · skipped 1 · wall 9.8s
failed: test:unit, require-all
skipped, dependency failed: deploy
reproduce: npx --no dag run scripts/ci.ts --only test:unit
```

## Compared to other tools

- **[act](https://github.com/nektos/act)** runs your YAML workflows locally, in Docker. dagworkflows replaces the steps of one job with a TypeScript graph of tasks and caches them. It does not use Docker.
- **[Turborepo](https://turborepo.com), [Nx](https://nx.dev) and [wireit](https://github.com/google/wireit)** run the scripts of a repository as a cached graph. dagworkflows does this for the steps of a CI job. GitHub's cache, artifacts, post steps and check runs are tasks in its graph.
- **Several GitHub Actions jobs** also run in parallel. But each job needs a new runner, a checkout and an install. dagworkflows runs the tasks in parallel on one runner.

## Documentation

- [Workflows](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/workflows.md): tasks, commands, dependencies, inputs, outputs, scheduler options and composition.
- [Cache and artifacts](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/cache-and-artifacts.md): `actions/cache` and `actions/upload-artifact` as tasks.
- [Lifecycle](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/lifecycle.md): post steps, timeouts and cancellation.
- [Output](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/output.md): the terminal, the log files, the GitHub log, check runs and the step summary.
- [Secrets](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/secrets.md): how commands get secrets, and how dagworkflows masks them.
- [Reference](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/reference.md): CLI options, action inputs, exit codes and files.
- [Run store API](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/api.md): draw a run with your own listeners.

## License

[MIT](https://github.com/mrmeku/dag/blob/main/LICENSE)
