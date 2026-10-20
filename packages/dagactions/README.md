<div align="center">

# dagactions

**Run a GitHub Actions job as a graph of cached steps, on GitHub and on your laptop.**

[![npm](https://img.shields.io/npm/v/@mrmeku/dagactions.svg)](https://www.npmjs.com/package/@mrmeku/dagactions)
[![CI](https://github.com/mrmeku/dag/actions/workflows/ci.yml/badge.svg)](https://github.com/mrmeku/dag/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/@mrmeku/dagactions.svg)](https://github.com/mrmeku/dag/blob/main/LICENSE)

<img src="https://raw.githubusercontent.com/mrmeku/dag/main/packages/dagactions/docs/media/demo.gif" width="720" alt="Two runs of npx dagactions run scripts/ci.ts. In the first run, six steps run and lint fails. In the second run, five steps come from the cache and only lint runs again.">

</div>

## Why dagactions

dagactions makes a CI job faster, and it makes a failure easier to fix. A GitHub Actions job runs its steps in sequence, and it runs all of them on each push. dagactions changes this in three ways:

- **Steps run in parallel.** Each step declares the steps that it needs. dagactions starts all other steps immediately, within the limits that you set.
- **Unchanged steps do not run.** Each step declares the files that it reads. If these files and the step's dependencies did not change, dagactions uses the result from the cache.
- **The same file runs on your laptop.** `npx dagactions run` shows the job live in your terminal. For each failure, it shows the log, the command, and the command that runs the step again.

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
   npm install --save-dev @mrmeku/dagactions
   ```

2. Write the workflow in `scripts/ci.ts`:

   ```typescript
   import { defineWorkflow } from "@mrmeku/dagactions";

   export default defineWorkflow({
     build: async (w) => {
       const src = await w.glob("src/**", "package.json", "tsconfig.json");
       w.runAll({
         typecheck: { cmd: ["npx", "tsc", "--noEmit"], inputs: src },
         lint: { cmd: ["npx", "eslint", "src"], inputs: src },
         test: { cmd: ["npm", "test"], inputs: src },
       });
     },
   });
   ```

   Each key of `runAll` is a step. These steps have no dependencies, so they start at the same time. `inputs` lists the files that a step reads.

3. Run the workflow locally:

   ```sh
   npx dagactions run scripts/ci.ts
   ```

4. Run the workflow again. All three steps come from the cache. Then edit `README.md` and run it again. No step runs, because no step reads `README.md`.

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
         - uses: mrmeku/dagactions@v0
           with:
             workflow: scripts/ci.ts
           env:
             GITHUB_TOKEN: ${{ github.token }}
   ```

   `checks: write` and `GITHUB_TOKEN` are optional. With them, each step shows as a check run on the pull request.

### Keep the cache between GitHub runs

Each GitHub runner starts with an empty cache. To use the results of the last run, restore the cache before the checks and save it after them. Both operations are steps in the graph:

```typescript
export default defineWorkflow({
  build: async (w) => {
    const cas = w.restoreCache({
      name: "restore:cas",
      path: [".dagactions/cas"],
      key: `dagactions-${w.ctx.sha}`,
      restoreKeys: ["dagactions-"],
    });
    const afterRestore = { deps: { cas }, invalidateOn: { cas: () => "" } };
    const src = await w.glob("src/**", "package.json", "tsconfig.json");
    const checks = w.runAll({
      typecheck: { cmd: ["npx", "tsc", "--noEmit"], inputs: src, ...afterRestore },
      lint: { cmd: ["npx", "eslint", "src"], inputs: src, ...afterRestore },
      test: { cmd: ["npm", "test"], inputs: src, ...afterRestore },
    });
    const gate = w.gate({ deps: checks });
    w.saveCache({ name: "save:cas", cache: cas, deps: { gate: w.settled(gate) } });
  },
});
```

- `deps: { cas }` starts each check after the restore.
- `invalidateOn: { cas: () => "" }` keeps the restored key out of the cache key of each check.
- `w.settled(gate)` saves the cache also when a check fails.

## Features

- **A graph of steps.** Steps declare their dependencies. Independent steps run in parallel, with a limit for the run and for each group. [Workflows](https://github.com/mrmeku/dag/blob/main/packages/dagactions/docs/workflows.md)
- **A content-addressed cache.** A step runs again only when its command, its input files, or the outputs of its dependencies change. [The cache key](https://github.com/mrmeku/dag/blob/main/packages/dagactions/docs/workflows.md#the-cache-key)
- **Files between steps.** A step writes output files, and other steps read them by reference. [Outputs](https://github.com/mrmeku/dag/blob/main/packages/dagactions/docs/workflows.md#outputs)
- **GitHub's cache and artifacts as steps.** `w.restoreCache`, `w.saveCache` and `w.uploadArtifact` are `actions/cache` and `actions/upload-artifact`. [Cache and artifacts](https://github.com/mrmeku/dag/blob/main/packages/dagactions/docs/cache-and-artifacts.md)
- **GitHub's job lifecycle.** Post steps, timeouts and cancellation behave as they do on GitHub. [Lifecycle](https://github.com/mrmeku/dag/blob/main/packages/dagactions/docs/lifecycle.md)
- **Output for each reader.** A live view in a terminal, a short report for an AI agent, and log groups, check runs and a step summary on GitHub. [Output](https://github.com/mrmeku/dag/blob/main/packages/dagactions/docs/output.md)
- **Secrets stay out of the cache.** Commands see secrets only through the environment, and dagactions masks them as GitHub does. [Secrets](https://github.com/mrmeku/dag/blob/main/packages/dagactions/docs/secrets.md)
- **Built on the actions toolkit.** `w.glob` and `w.hash` match what `hashFiles()` matches, byte for byte.

## How it works

dagactions runs a graph of steps, and it caches the result of each step by the content of what the step reads. The graph engine is [`@mrmeku/dagraph`](https://github.com/mrmeku/dag/tree/main/packages/dagraph). dagactions adds the steps that a GitHub Actions job uses.

| Term       | Meaning                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| Step       | One command, or one GitHub operation such as a cache restore. The output calls a step a _node_.                  |
| Dependency | A step that must finish before another step starts. Declare it in `deps`.                                        |
| Input      | A file outside the graph that a step reads. Declare it in `inputs`.                                              |
| Output     | A file that a step writes to `$DAGACTIONS_OUT`. Other steps read it.                                             |
| CAS        | The content-addressed store in `.dagactions/cas`. It holds the outputs of each step, by cache key.               |
| Cache key  | A hash of the step's command and `env`, the content of its inputs, and the content of its dependencies' outputs. |

Before a step runs, dagactions calculates its cache key. If the CAS has an entry for the key, the step does not run. dagactions uses the stored outputs.

If a step runs again but writes the same outputs, its dependents do not run again. Thus a change that does not change a step's outputs stops at that step.

## Output

dagactions shows each run in the format that its reader needs. It selects the format from where it runs:

| Where it runs  | What it shows                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| A terminal     | One line for each step that finishes, a block for each failure, and a live footer with the steps that run now. |
| An AI agent    | Only the failures and a recap, in plain text, in approximately 10,000 characters.                              |
| A pipe or CI   | The full log of each step, in groups, as GitHub shows it.                                                      |
| GitHub Actions | A log group, an annotation and a check run for each step, and a step summary with a timeline and the graph.    |

Each local run also writes the log of each step to `.dagactions/logs/` and a report of the failures to `.dagactions/failures.md`. Give this report to a person or an agent that must fix the failures.

Each run ends with a recap. The recap names the step that caused the failure, and the command that runs that step again:

```
✖ test:unit failed · scripts/ci.ts · built 1 · cached 4 · failed 2 · skipped 1 · wall 9.8s
failed: test:unit, gate
skipped, dependency failed: deploy
reproduce: npx dagactions run scripts/ci.ts --only test:unit
```

## Compared to other tools

- **[act](https://github.com/nektos/act)** runs your YAML workflows locally, in Docker. dagactions replaces the steps of one job with a TypeScript graph and caches them. It does not use Docker.
- **[Turborepo](https://turborepo.com), [Nx](https://nx.dev) and [wireit](https://github.com/google/wireit)** run the scripts of a repository as a cached graph. dagactions does this for the steps of a CI job. GitHub's cache, artifacts, post steps and check runs are steps in its graph.
- **Several GitHub Actions jobs** also run in parallel. But each job needs a new runner, a checkout and an install. dagactions runs the steps in parallel on one runner.

## Documentation

- [Workflows](https://github.com/mrmeku/dag/blob/main/packages/dagactions/docs/workflows.md): steps, dependencies, inputs, outputs and limits.
- [Cache and artifacts](https://github.com/mrmeku/dag/blob/main/packages/dagactions/docs/cache-and-artifacts.md): `actions/cache` and `actions/upload-artifact` as steps.
- [Lifecycle](https://github.com/mrmeku/dag/blob/main/packages/dagactions/docs/lifecycle.md): post steps, timeouts and cancellation.
- [Output](https://github.com/mrmeku/dag/blob/main/packages/dagactions/docs/output.md): the terminal, the log files, the GitHub log, check runs and the step summary.
- [Secrets](https://github.com/mrmeku/dag/blob/main/packages/dagactions/docs/secrets.md): how commands get secrets, and how dagactions masks them.
- [Reference](https://github.com/mrmeku/dag/blob/main/packages/dagactions/docs/reference.md): CLI options, action inputs, exit codes and files.
- [Run store API](https://github.com/mrmeku/dag/blob/main/packages/dagactions/docs/api.md): draw a run with your own listeners.

## License

[MIT](https://github.com/mrmeku/dag/blob/main/LICENSE)
