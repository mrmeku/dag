# Reference

The tables in this file come from the source. Do not edit them. To change a table, change its source and run `bun run docs` in `dag/`:

| Section       | Source                                 |
| ------------- | -------------------------------------- |
| CLI           | The commander program in `src/cli.ts`. |
| Action inputs | `action/action.yml`.                   |
| Files         | The paths in `src/config.ts`.          |

## CLI

<!-- generated:cli -->

```
npx --no dag run <workflow> [options]
npx --no dag post <workflow> [options]
```

| Command | What it does                                                         |
| ------- | -------------------------------------------------------------------- |
| `run`   | Execute a workflow file that default-exports defineWorkflow(...).    |
| `post`  | Run the post steps that stopped runs' histories show as not reached. |

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

## Action inputs

```yaml
- uses: mrmeku/dagworkflows@v0
  with:
    workflow: scripts/ci.ts
```

<!-- generated:action -->

| Input         | Default        | Meaning                                                                                      |
| ------------- | -------------- | -------------------------------------------------------------------------------------------- |
| `workflow`    |                | Path to the workflow file that default-exports defineWorkflow(...). Required.                |
| `cas-dir`     | `.dag/cas`     | Local content-addressed cache directory.                                                     |
| `history-dir` | `.dag/history` | Where each run records what started and settled, in a history of its own, for the post step. |
| `force`       | `false`        | Ignore the cache for this run.                                                               |
| `only`        |                | Comma-separated nodes to run, with the post steps of what runs, each with its dependencies.  |

<!-- /generated:action -->

The action has its own copy of `@mrmeku/dagworkflows`. Thus the workflow file loads also before `npm install`.

## Exit codes

| Code | `run`                                       | `post`                                   |
| ---- | ------------------------------------------- | ---------------------------------------- |
| 0    | All tasks succeeded or came from the cache. | All post steps that it ran succeeded.    |
| 1    | A task did not succeed.                     | A post step that it ran did not succeed. |
| 130  | The run was cancelled.                      |                                          |

The action uses the same codes.

## Files

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

Add `.dag/` to `.gitignore`.

## Configuration

The constants in [`src/config.ts`](../src/config.ts) control the paths, the timeouts, the budgets and the terminal layout. A comment above each constant tells what it controls.
