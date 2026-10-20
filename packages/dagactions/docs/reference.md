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
npx dagactions run <workflow> [options]
npx dagactions post <workflow> [options]
```

| Command | What it does                                                         |
| ------- | -------------------------------------------------------------------- |
| `run`   | Execute a workflow file that default-exports defineWorkflow(...).    |
| `post`  | Run the post steps that stopped runs' histories show as not reached. |

| Option                          | Commands      | Default                   | Meaning                                                                                                                           |
| ------------------------------- | ------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--force`                       | `run`         |                           | Ignore the cache for this run.                                                                                                    |
| `--output-style <style>`        | `run`         |                           | Terminal output (default: picked from the terminal). One of `live`, `failures`, `grouped`. Also set by `DAGACTIONS_OUTPUT_STYLE`. |
| `--log-dir <dir>`               | `run`         | `.dagactions/logs`        | Where each node's log is written as it runs.                                                                                      |
| `--failures-report-file <file>` | `run`         | `.dagactions/failures.md` | Where the report of the run's failures is written.                                                                                |
| `--only <names>`                | `run`, `post` |                           | Comma-separated nodes to run, with their dependencies and the post steps of what runs.                                            |
| `--cas-dir <dir>`               | `run`, `post` | `.dagactions/cas`         | Local content-addressed cache directory.                                                                                          |
| `--history-dir <dir>`           | `run`, `post` | `.dagactions/history`     | Where each run records what settled, in a history of its own.                                                                     |
| `--summary-file <file>`         | `run`, `post` | `.dagactions/summary.md`  | Where the local adapter writes the markdown summary.                                                                              |

<!-- /generated:cli -->

## Action inputs

```yaml
- uses: mrmeku/dagactions@v0
  with:
    workflow: scripts/ci.ts
```

<!-- generated:action -->

| Input         | Default               | Meaning                                                                                         |
| ------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| `workflow`    |                       | Path to the workflow file that default-exports defineWorkflow(...). Required.                   |
| `cas-dir`     | `.dagactions/cas`     | Local content-addressed cache directory.                                                        |
| `history-dir` | `.dagactions/history` | Directory where each run records every settled node in a history of its own, for the post step. |
| `force`       | `false`               | Ignore the cache for this run.                                                                  |
| `only`        |                       | Comma-separated nodes to run, with their dependencies and the post steps of what runs.          |

<!-- /generated:action -->

The action has its own copy of `@mrmeku/dagactions`. Thus the workflow file loads also before `npm install`.

## Exit codes

| Code | `run`                                       | `post`                                   |
| ---- | ------------------------------------------- | ---------------------------------------- |
| 0    | All steps succeeded or came from the cache. | All post steps that it ran succeeded.    |
| 1    | A step did not succeed.                     | A post step that it ran did not succeed. |
| 130  | The run was cancelled.                      |                                          |

The action uses the same codes.

## Files

<!-- generated:files -->

| Path                             | Content                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `.dagactions/cas/`               | The outputs of each step, by cache key. Cache this directory between runs.                                                                      |
| `.dagactions/cas.logs/<key>.log` | The log of each step, next to the CAS and not in it. Never cache it.                                                                            |
| `.dagactions/cas/last-run.json`  | The time of each step in the last run. The footer and the step summary compare with it.                                                         |
| `.dagactions/history/`           | The history of each run: each step that finished, with the run's lock. `dagactions post`, the action's `post` entry and the next run read them. |
| `.dagactions/logs/`              | Local runs only: the log of each step, while it runs.                                                                                           |
| `.dagactions/failures.md`        | Local runs only: the report of the failures.                                                                                                    |
| `.dagactions/summary.md`         | Local runs only: the step summary that GitHub would show.                                                                                       |

<!-- /generated:files -->

Add `.dagactions/` to `.gitignore`.

## Configuration

The constants in [`src/config.ts`](../src/config.ts) control the paths, the timeouts, the budgets and the terminal layout. A comment above each constant tells what it controls.
