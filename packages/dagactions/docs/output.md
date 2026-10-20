# Output

dagactions shows each run in the format that its reader needs:

- **In a terminal**, a person watches the run live and reads each failure once.
- **An AI agent** gets only the failures, in plain text, in a fixed budget of characters.
- **On GitHub**, each step gets a log group, a check run and a line in the step summary.

All formats come from one store of the run. To draw a run in your own format, see [Run store API](api.md).

## Output styles

A local run selects one of three styles:

| Style      | Selected when                                                                        | What it prints                                                                                   |
| ---------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `live`     | stdout is a terminal.                                                                | One line for each step, a block for each failure, and a live footer.                             |
| `failures` | An AI agent runs the command, as [std-env](https://github.com/unjs/std-env) detects. | The failure blocks and the recap, in approximately 10,000 characters. The rest is in the report. |
| `grouped`  | The run is in CI or stdout is a pipe.                                                | The full log of each step, as GitHub groups it.                                                  |

To select a style, use `--output-style` or `DAGACTIONS_OUTPUT_STYLE`.

Only `live` uses color, and it links paths (OSC 8) where the terminal can show links. `failures` writes plain text also in a terminal, so an agent's budget holds no escape codes.

dagactions removes color and other escape codes from the command output that `live` and `failures` print, and from the log files and the report. `grouped` prints the output as GitHub does. dagactions does not force color on commands. Commands write to a pipe, as on GitHub, because dagactions caches their output.

## The terminal

A local run writes only to the terminal's scrollback. It does not take the full screen.

When a step finishes, `live` writes one line for it. When a step fails, `live` writes a block:

```
✖︎ lint  exit 1 · 2.9s · 8 lines
│ src/feed.ts:41:5  error  Unexpected console statement  no-console
│ ✖ 1 problem (1 error, 0 warnings)
├ log    .dagactions/logs/lint.log
├ cmd    bun run lint   (cwd .)
└ rerun  npx dagactions run scripts/ci.ts --only lint
✔︎ typecheck        6.3s · 3 lines
⠼ docker:build     1m04s / ~2m10s  #14 [builder 6/7] RUN bun run build
⠼ test:pipeline    3.9s / ~12s  (pass) buildPipelineGraph > wires deps
· test:cli         queued: test 2/2
[3/9 ✖︎1] 2 running · 1 queued · ctrl-c cancels
```

The block holds these lines:

1. The last lines of the log.
2. The error, if the exit code does not explain the failure.
3. The path of the log file.
4. The command, in a format that a shell accepts.
5. The command that runs the step again.

### The footer

Below the scrollback, a footer shows the steps that run now. For each step, it shows the time, the time of the last run, and the last line that the step printed. A step that did not start yet shows "checking cache". A step that waits shows why it waits.

The footer is never taller than half the terminal, or `LIVE_MAX_ROWS` (8) rows. When the run ends, the footer goes away and the recap prints.

The footer has these limits:

- If you push Enter while the footer shows, a blank row stays in the scrollback.
- If you make the window narrower, dagactions draws the footer again in full, because most terminals reflow their lines.
- A command that asks for input on the terminal, as `ssh` or a git credential prompt does, has its prompt drawn over. Run such a workflow with `--output-style grouped`.

### Which failure is the cause

A step's failure is its own when the step ran its command. This is true also after a dependency that it takes with `w.settled` failed. A step that failed only because a dependency failed, for example a gate, shows under the failure that caused it. The skipped steps also show there.

## Log files and the failures report

Each local run writes two types of files, in all styles.

**Log files.** dagactions writes the log of each step to `.dagactions/logs/<step>.log` as the step prints it. A `:` or `/` in a step name makes a directory. Use `tail -F` to follow a running step. These rules apply:

- dagactions replaces a step's log file when the step starts.
- When a step finishes without output, as a cache hit does, dagactions copies its log from the CAS.
- The log files of steps outside the run stay.

**The failures report.** `.dagactions/failures.md` is the file to give to a person or an agent that must fix the failures. For each failure, it holds:

- the command, and the exit code or the error,
- the log file and the last lines of the log,
- the dependencies that also failed,
- the steps that the failure caused to fail or skip,
- the command that runs the step again.

dagactions writes the report when each pass starts, when a step fails, and when the run ends. It also writes it when the run has an error, or when a second Ctrl-C stops the run.

Use `--log-dir` and `--failures-report-file` to change these paths. `dagactions post` writes neither file.

## The GitHub log

On GitHub, dagactions writes these items to the log:

- A line when a step starts, with the duration of the step in the last run. Cached steps get no line.
- One collapsible group for each step that ran. dagactions writes the group when the step finishes, so the output of parallel steps does not mix. The group holds stdout and stderr in the order that the command wrote them.
- One line for each step that was skipped or cancelled.
- An annotation for each failure.

The runner reads the workflow commands in each log, as it does for a `run:` step. These rules apply:

- dagactions does not cache logs. Thus a cached step on a new runner shows no log.
- If a command leaves `::stop-commands::` open, dagactions ends it at the end of the group, as GitHub does at the end of a step.
- A step that a cancellation stopped shows the log that it wrote before it stopped.

### The recap

The log ends with a recap, outside all groups. Thus a failed step shows the recap last:

```
✖ test:unit failed · scripts/ci.ts · built 1 · cached 4 · failed 2 · skipped 1 · wall 9.8s
failed: test:unit, gate
skipped, dependency failed: deploy
reproduce: npx dagactions run scripts/ci.ts --only test:unit
```

The cause of a failure is a failed step that has no failed dependency. Above, `gate` failed because `test:unit` failed. Thus the first line and the `reproduce` line name only `test:unit`.

## Check runs

dagactions makes one check run for each step, in the Checks tab of the pull request. The check runs update while the run continues, and each one links to the run's log.

Check runs need two things. If one is missing, dagactions makes no check runs and shows no error:

1. The permission `checks: write`.
2. `GITHUB_TOKEN` in the `env` of the action step.

## The step summary

The step summary is a list of renderers under the heading `## <workflow file>`. A renderer is a function. It gets the run's data, a `RunReport`, and it returns lines of Markdown. To draw nothing, it returns `[]`.

The `RunReport` holds each step with its status, time, previous time, error and outputs. `log(name)` reads the log of a step.

| Renderer             | Draws                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `renderStatus`       | The result as a heading, then counts, wall time, parallelism, cache hits and the time they saved.                       |
| `renderTimeline`     | A Gantt chart of the steps that ran.                                                                                    |
| `renderCriticalPath` | The longest chain by time, of steps that took `CRITICAL_PATH_FLOOR_MS` (1 s) or more. If no step did, it draws nothing. |
| `renderDag`          | The graph, colored by status.                                                                                           |
| `renderFailures`     | The end of the log of each failed step, and a line for each skipped or cancelled step.                                  |
| `renderTable`        | Each step, its status, its time and the change from the previous run.                                                   |

`DEFAULT_SUMMARY_RENDERERS` holds all renderers except `renderTable`.

### Select the renderers

Set `summary` in the workflow to change the list. You can mix the built-in renderers with your own. Your renderer can call a built-in renderer, with a filtered report:

```typescript
import {
  defineWorkflow,
  formatDuration,
  renderDag,
  renderFailures,
  renderTimeline,
  type RunReport,
} from "@mrmeku/dagactions";

// The steps that are slower than in the last run.
const renderSlower = (r: RunReport) => {
  const rows = r.nodes.flatMap((n) =>
    n.status === "done" && n.duration !== undefined && n.previous && n.duration > n.previous * 1.2
      ? `- ${n.name}: ${formatDuration(n.previous)} → ${formatDuration(n.duration)}`
      : [],
  );
  return rows.length > 0 ? ["### slower than last run", "", ...rows] : [];
};

// The graph without the cache steps, in a folded section.
const renderFoldedDag = (r: RunReport) => [
  "<details><summary>DAG</summary>",
  "",
  ...renderDag({ ...r, nodes: r.nodes.filter((n) => !/^(restore|save):/.test(n.name)) }),
  "",
  "</details>",
];

export default defineWorkflow({
  summary: [renderTimeline, renderFoldedDag, renderSlower, renderFailures],
  build: async (w) => {
    // ...
  },
});
```

| `summary`                                     | Result                                       |
| --------------------------------------------- | -------------------------------------------- |
| Not set                                       | `DEFAULT_SUMMARY_RENDERERS`.                 |
| `[...DEFAULT_SUMMARY_RENDERERS, renderTable]` | The default list, with the table at the end. |
| `[]`                                          | An empty summary.                            |

These rules apply:

- If a renderer throws an error, the summary shows a note in its place, and the log shows a warning annotation. The result of the run does not change.
- The post pass draws its post steps with the same list.
- The summary has a limit of `SUMMARY_BUDGET_BYTES` (900,000 UTF-8 bytes), below GitHub's limit of 1 MiB. Above the limit, dagactions first removes the log blocks (` ```text ` fences). Then it removes each block that does not fit. Thus the renderers at the start of the list keep their space.
