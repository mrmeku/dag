# dagworkflows

Write your CI job as a TypeScript graph of tasks that runs in parallel, reuses the results of tasks whose inputs did not change, and runs the same on your laptop and on GitHub.

[![npm](https://img.shields.io/npm/v/@mrmeku/dagworkflows)](https://www.npmjs.com/package/@mrmeku/dagworkflows) [![CI](https://github.com/mrmeku/dag/actions/workflows/ci.yml/badge.svg)](https://github.com/mrmeku/dag/actions/workflows/ci.yml) [![license](https://img.shields.io/npm/l/@mrmeku/dagworkflows)](https://github.com/mrmeku/dag/blob/main/LICENSE)

## Why dagworkflows

A CI job is usually a YAML list of steps that runs top to bottom, every time. Steps that could run side by side wait for each other, and steps whose inputs did not change run again anyway. With dagworkflows you write the job as a TypeScript file that builds a graph of tasks. Each task names what it depends on and what decides its result.

- **Independent tasks run in parallel.** Tasks that do not depend on each other start together.
- **Unchanged tasks do not run again.** A task whose declared inputs did not change comes from the CAS, a content-addressed cache of task outputs in `.dag/cas`.
- **One file runs everywhere.** The same workflow file runs with the `dag` CLI on a laptop, with the GitHub Action in CI, and in a unit test.
- **A teardown stays owed until it succeeds.** A task can declare a post step, such as stopping the database it started. The post step is owed from the moment its task starts. Not even a crash loses it: the next run of that file pays it before any task starts.

## Install

```sh
npm install --save-dev @mrmeku/dagworkflows
```

This gives your project the `dag` command. The workflow file is TypeScript, with no build step.

## Quick start

In a git repository, put a file `src/index.js` holding `console.log("hi")`, and this workflow file at the root:

```ts
// ci.ts
import { defineWorkflow } from "@mrmeku/dagworkflows";

export default defineWorkflow({
  implementation: async (workflow) => {
    const src = await workflow.glob("src/**");
    const lint = workflow.task({
      name: "lint",
      cmd: ["node", "--check", "src/index.js"],
      inputs: { version: "lint-v1", ...src },
    });
    workflow.task({
      name: "test",
      shell: "node src/index.js",
      inputs: { version: "test-v1", ...src },
      deps: { lint },
    });
  },
});
```

`workflow.glob("src/**")` lists the files under `src/`. Both tasks declare them, with a version string, as the `inputs` that decide their result. `lint` runs a program with its arguments (`cmd`). `test` runs a shell string, and only once `lint` has succeeded (`deps`). Run it:

```sh
npx --no dag run ci.ts --output-style grouped
```

`--output-style grouped` prints each node's log as a block. On a branch named `master` it printed:

```
▶ ci.ts · ref=refs/heads/master · 2 nodes
    lint
    test
▷ lint
▶ ✔︎ lint (38ms)
▷ test
▶ ✔︎ test (47ms)
    hi
summary: .dag/summary.md

✔︎ all 2 nodes succeeded · ci.ts · built 2 · cached 0 · failed 0 · skipped 0 · wall 86ms
```

Run it again with nothing changed, and both tasks come from the CAS. The blocks now read `▶ ✔︎ lint (cached)` and `▶ ✔︎ test (cached)`, and the last line counts `built 0 · cached 2`.

A task is cached on what it declares: its inputs, its command and the content its dependencies produced. It is never cached on its code, so a file it reads but does not declare reruns nothing when it changes. A task that declares no inputs runs every time, and `--force` builds every task again. The rules are in [Inputs and when a task runs](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/workflows.md#inputs-and-when-a-task-runs).

After the first run, `git status` lists `.dag/` as untracked. Add the line `.dag/` to your `.gitignore` before you commit.

## What a run writes

Every default path sits under `.dag/`, so that one `.gitignore` line covers them all.

<!-- generated:files -->

| Path                      | Content                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `.dag/cas/`               | The outputs of each task, by cache key. Cache this directory between runs.                                                               |
| `.dag/cas.logs/<key>.log` | The log of each task, next to the CAS and not in it. Never cache it.                                                                     |
| `.dag/cas/last-run.json`  | The time of each task in the last run. The footer and the step summary compare with it.                                                  |
| `.dag/history/`           | The history of each run: each task that finished, with the run's lock. `dag post`, the action's `post` entry and the next run read them. |
| `.dag/logs/`              | Local runs only: the log of each task, while it runs.                                                                                    |
| `.dag/failures.md`        | Local runs only: the report of the failures.                                                                                             |
| `.dag/summary.md`         | Local runs only: the step summary that GitHub would show.                                                                                |

<!-- /generated:files -->

## On GitHub

Save this job as `.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push:
    branches: [main] # your repository's default branch
  pull_request:

permissions:
  contents: read
  checks: write # one check run per node

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mrmeku/dagworkflows@v1
        with:
          workflow: ci.ts
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

The action, published from [mrmeku/dagworkflows](https://github.com/mrmeku/dagworkflows), runs the same workflow file. It answers the file's import of `@mrmeku/dagworkflows` with its own bundled copy. So a checkout is enough to start, and installing dependencies can be a task of the graph. With `GITHUB_TOKEN` in the step's `env` and the permission `checks: write`, each node gets a check run.

GitHub starts each job on a fresh machine. Unless the workflow file caches the CAS, every run starts with an empty one and builds everything: see [Keep the CAS between runs](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/github.md#keep-the-cas-between-runs). Which ref to pin is in the [action's README](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/action/README.md#versions).

## Command line

<!-- generated:cli -->

```
npx --no dag run <workflow> [options]
npx --no dag post <workflow> [options]
```

| Command | What it does                                                        |
| ------- | ------------------------------------------------------------------- |
| `run`   | Execute a workflow file that default-exports defineWorkflow(...).   |
| `post`  | Run the post steps that stopped runs' histories show as still owed. |

| Option                          | Commands      | Default            | Meaning                                                                                                                    |
| ------------------------------- | ------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `--force`                       | `run`         |                    | Ignore the cache for this run.                                                                                             |
| `--output-style <style>`        | `run`         |                    | Terminal output (default: picked from the terminal). One of `live`, `failures`, `grouped`. Also set by `DAG_OUTPUT_STYLE`. |
| `--log-dir <dir>`               | `run`         | `.dag/logs`        | Where each node's log is written as it runs.                                                                               |
| `--failures-report-file <file>` | `run`         | `.dag/failures.md` | Where the report of the run's failures is written.                                                                         |
| `--only <names>`                | `run`, `post` |                    | Comma-separated nodes to run, with the post steps of what runs, each with its dependencies.                                |
| `--cas-dir <dir>`               | `run`, `post` | `.dag/cas`         | Local content-addressed cache directory.                                                                                   |
| `--history-dir <dir>`           | `run`, `post` | `.dag/history`     | Where each run records what started and settled, in a history of its own.                                                  |
| `--summary-file <file>`         | `run`, `post` | `.dag/summary.md`  | Where the local adapter writes the markdown summary.                                                                       |

<!-- /generated:cli -->

`dag run` exits 0 when every node was built or cached, 1 when any node did not succeed or the run errored, and 130 when a cancel stopped it.

## Documentation

- Writing tasks, inputs, post steps or tests: [Write a workflow](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/workflows.md).
- A run went red: [Fix a failed run](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/runs.md).
- Caching the CAS, uploading artifacts, check runs, the step summary or secrets on GitHub: [Run on GitHub](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/github.md).
- The action's inputs and versions: the [action's README](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/action/README.md).
- Every export: the [API reference](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/api/README.md).
- The engine underneath: [dagraph](https://github.com/mrmeku/dag/blob/main/packages/dagraph/README.md).

## License

MIT. See [LICENSE](https://github.com/mrmeku/dag/blob/main/LICENSE).
