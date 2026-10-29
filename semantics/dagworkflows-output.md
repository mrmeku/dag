# dagworkflows: what a run shows

## The problem and the core idea

A CI run is only as useful as what it tells you. When forty tasks run in parallel, their output interleaves into noise. When one fails, five others fail or are skipped because of it, and the reader has to work out which failure to fix. The same run has several readers: a person at a terminal who wants to see progress, an AI agent that reads a command's output through a tool with a small budget, GitHub's job log, the pull request's Checks tab, and the run's summary page.

dagworkflows draws one run several ways from one model. Every output listens to a **run store**, which turns the engine's events (a node dispatched, started, printed, settled) into a state of the run. The store keeps dagraph's own word for how each node settled, its `Result`, as it is, with the times dagraph stamped on its events; what it adds is what only a controller knows: the passes, the run's lifecycle, the lines each node printed, its CAS log and the last run's durations. Each output is a **listener** on that store and draws the run its own way: the terminal in one of three **output styles**, per-node log files, a failures report, GitHub's log groups and check runs. The step summary is not a listener: at the end of each pass it is rendered from the store's report of that pass and handed to the host, so a custom store does not replace it. A node's log is kept on disk next to the cache, so a cache hit or a failure still shows the full output of the run that produced it.

Terms used throughout:

- **Node**: one task in the workflow's graph, named uniquely (for example `lint` or `test:unit`).
- **Settle**: a node reaching its final status. The statuses are `done` (built), `cached` (a cache hit), `failed`, `dep-failed` (skipped because a required dependency did not succeed) and `cancelled`.
- **Pass**: one go of the runner over a set of nodes. A normal run is one pass. After a cancel, a second **post pass** runs the post steps the run still owes ([dagworkflows-lifecycle](dagworkflows-lifecycle.md)).
- **Host**: the port through which a run reaches its environment: log groups, plain lines, annotations, the step summary and check runs. There is a GitHub host and a local host (`Host` in the public API).
- **Annotation**: an error, warning or notice with a title. On GitHub it is a workflow annotation. Locally it is a line `[level] title: message`.
- **Failure** and **skipped because of it**: every failed node is named; a skipped node only under the failures that caused it, explained in "Which failure is the cause".
- **CAS**: the content-addressed cache of task outputs, `.dag/cas` by default ([dagworkflows-cache-artifacts](dagworkflows-cache-artifacts.md)).
- **Recap**: the last lines a run prints: its outcome, its causes and what to rerun.

Where it lives: `packages/dagworkflows/src/kernel/store.ts`, `src/kernel/run-slice.ts`, `src/local/session.ts`, `src/github/renderer.ts`.

## Where the output goes

| Where the run is                                           | What it shows                                                                                                                                                                                             |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dag run` in a terminal or under an agent (not GitHub)     | The terminal in the `live`, `failures` or `grouped` style; each node's log in `.dag/logs/`; a failures report in `.dag/failures.md`; the step summary as markdown in `.dag/summary.md`.                   |
| `dag run` with `GITHUB_ACTIONS=true`, or the GitHub Action | GitHub's job log: a log group per node, annotations, a recap. A check run per node in the Checks tab when a token allows it. The step summary on the run page. No local log files and no failures report. |
| `dag post` locally                                         | The GitHub-shaped log printed on the local host (`▶` groups), and the summary file. No log files and no failures report.                                                                                  |
| A program that calls `createReporter` or `createRunStore`  | Whatever its host and listeners draw.                                                                                                                                                                     |

Off GitHub, `dag run` builds a **local session**: the terminal style, the log files and the failures report, all listening to one run store. On GitHub there is no session, so `--output-style`, `--log-dir`, `--failures-report-file` and `--summary-file` have no effect there. The step summary goes to `$GITHUB_STEP_SUMMARY`.

Where it lives: `src/cli.ts`, `src/local/session.ts`, `src/action/env.ts`.

## The public surface at a glance

### CLI options of `dag run` that shape output

| Option                          | Default                          | Meaning                                                                                                                                                                       |
| ------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--output-style <style>`        | picked from the terminal (below) | `live`, `failures` or `grouped`. Also read from the environment variable `DAG_OUTPUT_STYLE`. The option wins over the variable. An empty `DAG_OUTPUT_STYLE=` counts as unset. |
| `--log-dir <dir>`               | `.dag/logs`                      | Where each node's log file is written as it runs.                                                                                                                             |
| `--failures-report-file <file>` | `.dag/failures.md`               | Where the failures report is written.                                                                                                                                         |
| `--summary-file <file>`         | `.dag/summary.md`                | Where the local host writes the step summary. `dag post` has this option too.                                                                                                 |

An unknown style is refused by the option parser, and `dag` exits 1:

```
error: option '--output-style <style>' argument 'bogus' is invalid. Allowed choices are live, failures, grouped.
```

A bad value in the environment variable is refused the same way, also with exit 1:

```
error: option '--output-style <style>' value 'bogus' from env 'DAG_OUTPUT_STYLE' is invalid. Allowed choices are live, failures, grouped.
```

By default every rerun line starts with `npx --no dag run` followed by the workflow file. The terminal's `rerun` lines come only from the local session, which always builds `npx --no dag run <shell-quoted workflow file>` and overrides any `rerunCommand` it is given. `RunOptions.rerunCommand` sets only the command at the start of GitHub's `reproduce:` line, used as given: the workflow file is not appended. A run with neither `rerunCommand` nor `workflowFile` prints no `reproduce:` line.

### Files

| Path (default)                   | Written by    | Content                                                                                                             |
| -------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `.dag/logs/<node>.log`           | local session | Each node's output as it arrives, as plain text.                                                                    |
| `.dag/failures.md`               | local session | The run's status and each failure with what it takes to fix it.                                                     |
| `.dag/summary.md`                | local host    | The step summary markdown.                                                                                          |
| `.dag/cas.logs/<action key>.log` | every task    | The raw log of the run that built a node, kept next to the CAS. With `--cas-dir <dir>` it is `<dir>.logs/`.         |
| `.dag/cas/last-run.json`         | run store     | `{"durations": {"<node>": <ms>}}`: each node's duration the last time its action ran: built, or failed once it ran. |

### Environment variables

| Variable                                                                                                                               | Effect                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DAG_OUTPUT_STYLE`                                                                                                                     | The terminal style, as `--output-style`.                                                                                             |
| `GITHUB_ACTIONS=true`                                                                                                                  | `dag run` and `dag post` use the GitHub host.                                                                                        |
| `GITHUB_TOKEN`                                                                                                                         | Turns check runs on (GitHub host only). Without it, check runs are off with no message.                                              |
| `GITHUB_STEP_SUMMARY`                                                                                                                  | Where GitHub's summary is written. When unset on the GitHub host, the summary markdown is printed into the log instead.              |
| `TERM=dumb`                                                                                                                            | The default style is `grouped`, not `live`.                                                                                          |
| `CI` and the other variables `std-env` reads as CI                                                                                     | The default style is `grouped`, and `supports-hyperlinks` turns off links in `live`. Nothing else in the CLI or the action reads it. |
| Agent variables that `std-env`'s `isAgent` reads (for example `CLAUDECODE`, `AI_AGENT`, `CURSOR_AGENT`, `GEMINI_CLI`, `CODEX_SANDBOX`) | The default style is `failures`.                                                                                                     |
| `NO_COLOR`, `NODE_DISABLE_COLORS`, `FORCE_COLOR`, `TERM`                                                                               | Whether `live` colours, as Node's `hasColors()` reads them on a terminal stdout.                                                     |
| `FORCE_HYPERLINK` and the other variables `supports-hyperlinks` reads                                                                  | Whether `live` prints paths as clickable links.                                                                                      |

### Exports of `@mrmeku/dagworkflows` that belong to output

| Export                                                                                                                                                                                                                                                                 | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEFAULT_SUMMARY_RENDERERS`                                                                                                                                                                                                                                            | The step summary's renderers when a workflow sets no `summary`: `[renderStatus, renderTimeline, renderCriticalPath, renderDag, renderFailures]`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `renderStatus`, `renderTimeline`, `renderCriticalPath`, `renderDag`, `renderFailures`, `renderTable`                                                                                                                                                                   | The built-in summary renderers. `renderTable` is not in the defaults.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SummaryRenderer` (type)                                                                                                                                                                                                                                               | A function that takes a `RunReport` and returns markdown lines, or a promise of them. `[]` draws nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `RunReport` (type)                                                                                                                                                                                                                                                     | `{ nodes: NodeReport[]; log: (name) => Promise<string[]> }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `NodeReport` (type)                                                                                                                                                                                                                                                    | One settled node: `{ node, result, start?, duration?, previous? }`, the graph's node, dagraph's `Result` as it is, and the store's timing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `formatDuration(ms)`                                                                                                                                                                                                                                                   | `"450ms"` under a second, else seconds with one decimal: `"1.5s"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `failureMessage({ node, result })`                                                                                                                                                                                                                                     | What every output says of a failed or skipped node, from its graph node and its result (a `NodeReport` or a node state): its error's message, or its own timeout in GitHub's words; `dependency <name> failed` for a skipped one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `createReporter(ports, opts)`                                                                                                                                                                                                                                          | GitHub-style output for a program that runs a dagraph graph itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `createRunStore(opts)`, `RunStore`, `RunListener`                                                                                                                                                                                                                      | The store every output listens to, for drawing a run yourself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `selectors` (namespace)                                                                                                                                                                                                                                                | Read-only queries over the run's state, including the failure rules.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| State types: `RunState`, `RunLifecycle`, `NodeState`, `PendingNodeState`, `InFlightNodeState`, `SucceededNodeState`, `FailedNodeState`, `DepFailedNodeState`, `FailureNodeState` (either), `CancelledNodeState`, `SettledNodeState`, `Pass`, `RunAction`, `NodeAction` | The run's state as the store holds it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Host`, `AnnotationLevel`, `CheckUpdate`, `CiContext` (types)                                                                                                                                                                                                          | The host port (see "Hosts").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `CommandCause` (type)                                                                                                                                                                                                                                                  | `{ argv: string[]; cwd: string; ended: "exited" \| "signalled" \| "not-started"; code: number }`, the `cause` of an error that a command failed; `ended` and `code` are the `ExecResult`'s. A function task can throw `new Error(message, { cause: { argv, cwd, ended, code } })`: its failure then shows a `cmd` row and, when it `exited` with a non-zero code, `exit <code>`. With `ended: "exited"`, a non-zero code and no timeout, the terminal and `failures.md` leave its message out, as if it said only the exit code, so a task that throws its own message that way loses it locally. The message still reaches GitHub's group, the error annotation and check runs. A cause missing a field, or with a field of the wrong type, is ignored. |
| `createLocalHost(opts)`, `nullHost()`                                                                                                                                                                                                                                  | The terminal host, and a host that draws nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `createRecordingHost(context?)`, `RecordedHost`                                                                                                                                                                                                                        | A host for tests that records `log`, `annotations`, `summaries` and `checks`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `logPath(casBaseDir, actionKey)`                                                                                                                                                                                                                                       | Where a node's raw log is kept: `` `${casBaseDir}.logs/${actionKey}.log` ``.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DEFAULT_SUMMARY_PATH`                                                                                                                                                                                                                                                 | `".dag/summary.md"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

The subpath `@mrmeku/dagworkflows/github` exports `createGithubHost(opts?)`, and two helpers it uses on log lines, `flattenGroups(lines)` and `openStopToken(lines)`.

A workflow chooses its summary with `defineWorkflow({ summary: [...] , implementation })`. `summary` is also a field of `RunOptions`.

## Choosing the terminal style

The three styles serve three readers:

- **`live`**, for a person at a terminal. Settled nodes scroll by. Under them a **footer** of running and waiting nodes is redrawn in place. It is the only style with colour and links.
- **`failures`**, for an AI agent. The output is append-only. It shows failures and warnings only, and it stays within about 10,000 characters, which is what an agent's tool shows of a command.
- **`grouped`**, for pipes, CI and anyone who wants every node's log. It is the GitHub renderer drawn on the local host: a `▶` block per node with its log indented.

Default, when neither `--output-style` nor `DAG_OUTPUT_STYLE` is given:

1. Under CI (as `std-env`'s `isCI` reads the environment): `grouped`.
2. Else under an agent (`std-env`'s `isAgent`): `failures`, even when stdout is a terminal.
3. Else if stdout is a TTY and `TERM` is not `dumb`: `live`.
4. Else: `grouped`.

Colour needs the `live` style and a terminal stdout that reports colours (`hasColors()`, which reads `NO_COLOR`, `NODE_DISABLE_COLORS`, `FORCE_COLOR` and `TERM`). Links (OSC 8 hyperlinks to the file's `file://` URL) need the `live` style and a terminal that `supports-hyperlinks` accepts. `failures` and `grouped` never colour or link. `grouped` prints a command's own escape codes unchanged.

`live` can be forced into a pipe. It then takes the terminal as 80 columns by 24 rows.

A cancel prints `SIGINT: cancelling, waiting for running commands to stop` (with the signal's name: `SIGTERM`, `SIGHUP`) on stdout in every style, before the recap.

Where it lives: `src/local/session.ts`, `src/config.ts`, `src/ports/real.ts` (the cancel line).

## Which failure is the cause

Every output names every failed node as a failure: a command that failed, a post step, a cache save, a task that failed after a `settled` dependency failed, and `workflow.requireAll` when a check it requires did not succeed. A `dep-failed` node never ran. It is shown as skipped, and only under the failures that caused it.

`requireAll` fails rather than being skipped on purpose. GitHub counts a skipped check as passing a required status check, so a required check that a failure upstream skipped would let the pull request merge. Its failure is named like any other. Its error, `failed: <roles>`, says which checks it went without, and its `deps` row and `dependencies that also failed:` line name them.

The **causes** of a skipped node are dagraph's `rootCauses` on its result: the nodes along its required dependencies that did not succeed and were not skipped themselves, through any skipped nodes in between. A dependency the node takes `settled` never makes it skipped, so it is never a cause, even when it failed too. The nodes a failure **brought down** are the skipped nodes whose causes include it ("skipped because of it"). A skipped node's cause is the failure it waits on: when `require-all` fails because `lint` did, `deploy` after `require-all` is skipped because of `require-all`.

Worked example. The graph is `install`; `lint` after `install`; `build` after `install`; `require-all` waits for `lint` and `build`; `deploy:site` after `require-all`; `upload` after `settled(lint)`; and `pack`. `install` and `build` succeed. `lint` prints `linting`, 70 lines `src/a<N>.ts:1:1<tab>error` and `70 problems`, then exits 1. `upload` prints `ECONNREFUSED 127.0.0.1:9000` and exits 3. `pack` exits 0 but does not write its declared output.

- Failures: `lint`, `require-all`, `upload`, `pack`. `deploy:site` was skipped because of `require-all`. `require-all` and `upload` list `lint` as a dependency that also failed: the `deps` row of the failure block (see "The `live` style") and the `dependencies that also failed:` line of `failures.md`.

Every headline of that run reads `✖︎ lint, require-all, upload and 1 more failed`, and every rerun line reruns `--only lint,require-all,upload,pack`.

Where it lives: `src/kernel/selectors.ts` (exported as `selectors`).

## Words every output shares

**Status icons** (each followed by U+FE0E, so that browsers do not draw an emoji):

| Status       | Icon                                  |
| ------------ | ------------------------------------- |
| `done`       | `✔︎`                                   |
| `cached`     | `✔︎` (the word "cached" says the rest) |
| `failed`     | `✖︎`                                   |
| `dep-failed` | `⏭︎`                                  |
| `cancelled`  | `◼︎`                                   |

**The headline** says what the run came to, in this order of precedence:

1. More than three failures named: `✖︎ a, b, c and 2 more failed`.
2. One to three: `✖︎ test:unit failed` or `✖︎ test, down:db failed`.
3. Else, if nodes were skipped: `⏭︎ 1 node skipped, a dependency failed`.
4. Else, if nodes were cancelled: `◼︎ cancelled, 2 nodes not run`.
5. Else: `✔︎ 1 node succeeded` or `✔︎ all 4 nodes succeeded`.

The terminal and `failures.md` add two cases. A run that threw reads `✖︎ errored: <first line of the error>`. A cancelled run with no failure reads `◼︎ cancelled, N nodes not run`, where N counts the cancelled and skipped nodes.

**The counts line**: `built 2 · cached 0 · failed 4 · skipped 1`, followed by ` · cancelled N` only when a node was cancelled. "built" counts `done` nodes. "skipped" counts `dep-failed` nodes.

**Durations.** A node whose action ran, as its result's `elapsed` says, takes that `elapsed`: dagraph's own time for the action, from just before it ran to its result, at least 1 ms. A cache hit takes the time from its dispatch to its result, as dagraph stamped those events. Any other node has none: a skipped node, and one that failed or was cancelled before its action ran. GitHub's log and the summary use `formatDuration` (`450ms`, `1.5s`). The terminal uses a clock: `4.0s` under a minute, otherwise `1m04s`. A node's **start** is when its `start` came, for a node whose action ran, or a cache hit's dispatch; any other node has none. Its end is its start plus its duration. **Wall time** runs from the first node's start to the last node's end.

**Timeouts** are a node's own `timeoutMs`, which dagraph marks with `timedOut` on the result. They use the words of GitHub's runner: `The action 'slow' has timed out after 15 minutes.` An action that throws its own error named `TimeoutError`, such as a fetch that timed out, is a plain failure with its own message. A timeout of a minute or more is written in minutes, with up to two decimals (`1.5 minutes`, `1.67 minutes`, `1 minute`). A shorter one is written as a duration (`after 6ms`).

**Failure messages** a user meets: a `cmd` task that exits non-zero fails with `<argv joined by spaces> exited <code>` (`lint exited 1`). A `shell` task fails with `its shell command exited <code>`. A program that cannot start fails with `could not start <program>. Check that it is on the command's PATH and that its cwd exists.` A command asked to run after the stop signal fired fails with `<argv joined> was stopped before it started`. A command that a signal killed fails with `<argv joined> was stopped` after the stop signal, else `<argv joined> was killed by a signal`. A command that exits after the stop signal, even with 0, fails with `<argv joined> was stopped` (or `its shell command …` in each case). A declared output the task did not write fails it with `output "<role>" (<file>) was not written. Write it at out.<role> before the action returns.` A `requireAll` fails with `failed: <roles>`: the keys of its `deps` record, sorted, for the deps that did not succeed, which are node names only when the keys happen to be. A skipped node's message is `dependency <name> failed`.

Each of a task's own messages carries the last command it ran, whatever that command's exit code. So a task that ran a command (even one that exited 0) and then missed an output gets a `cmd` row. A function task that ran no command gets no `cmd` row.

**A command that could not start** is recorded as such: its `CommandCause` has `ended: "not-started"` (and code `-1`). Only a command that `exited` with a non-zero code shows `exit <code>` and has its message left out, so the terminal's block and `failures.md` show no exit code and give the message: the log line `spawn lint ENOENT`, then `could not start lint. Check that it is on the command's PATH and that its cwd exists.` A command a signal killed is shown the same way, with its message.

Where it lives: `src/kernel/format.ts` (`failureMessage`, the timeout's words), `src/kernel/selectors.ts` (durations), `src/task.ts` (task messages), `src/steps.ts` (`requireAll`).

## The `live` style

A person's view. Lines go into the terminal's scrollback as nodes settle. Under them a footer shows what runs now.

**The title.** The first pass prints its banner title in bold followed by ` · logs .dag/logs/`, for example `ci.ts · ref=refs/heads/main · 4 nodes · logs .dag/logs/`. The banner title holds the workflow file, `ref=<ref>` when there is a ref, the node count (`2 of 5 nodes (--only a,b)` under `--only`) and `force` under `--force`. A later pass prints its own title only if it has nodes, for example `post · 1 of 1 post steps owed`.

**Settled nodes**, one line each, names padded to the longest name in the run (at most 24 columns, never cut):

- built: `✔︎ lint      1.2s · 2 lines`.
- a cache hit: never a line of its own. Cache hits gathered since the last print are written as one line, `✔︎ cached: build, docs`, at the next print or the next footer redraw (every 100 ms), whichever comes first. So a cached line can show up alone within 100 ms.
- a failure: a **failure block** (below).
- skipped: `⏭︎ deploy skipped (because lint failed)`.
- cancelled once its action ran: `◼︎ slow cancelled after 31.0s`. A node cancelled before its action ran prints nothing, even one that was dispatched and had looked its key up, or whose start had come (its result has no `elapsed`).
- the node's warnings follow its line (see "Warnings").

**The failure block** of a failure. In the worked example of "Which failure is the cause", `lint`'s block is (the `│ …` row stands for the lines `src/a53.ts` to `src/a69.ts`, which the block prints):

```
✖︎ lint  exit 1 · 0.0s · 72 lines
│ … 52 earlier lines
│ src/a52.ts:1:1	error
│ …
│ 70 problems
├ log    .dag/logs/lint.log
├ cmd    lint   (cwd .)
└ rerun  npx --no dag run ci.ts --only lint
```

`lint`'s dependency `install` succeeded, so its block has no `deps` row. `upload` ran its own command after its `settled` dependency `lint` failed, so its block has one:

```
✖︎ upload  exit 3 · 0.0s · 1 line
│ ECONNREFUSED 127.0.0.1:9000
├ log    .dag/logs/upload.log
├ cmd    upload   (cwd .)
├ deps   lint also failed
└ rerun  npx --no dag run ci.ts --only upload
```

The clocks vary from run to run.

- The header holds how the node ended (`not started` for a node that failed before its action ran, `timed out`, or `exit N` for a command that exited non-zero), its clock and its line count. A node that failed before its action ran has no clock, no lines and no `log` row: `✖︎ lint  not started`, its error, then `└ rerun …`. In the recap its line reads `✖︎ lint   not started`.
- The log is shown whole up to 40 lines. Otherwise its last 20 lines are shown, after `… N earlier lines`.
- Each line is shown as a terminal would leave it: escape codes and control characters dropped, only the text after the last carriage return. A line is cut at 500 characters with `…`. The log file keeps it whole.
- The error follows the tail, in red, unless it says only what the exit code says (`lint exited 1`). That is decided from the error's `CommandCause`, not from its text: any failed node whose cause `exited` with a non-zero code and that did not time out has its message left out, whatever the message says. A timeout's message, a missing output's message, a killed command's and one that could not start are shown.
- The labelled rows: `log` (only when a log file was written), `cmd` (the last command the node ran, shell-quoted, with its cwd; whenever its error carries one, even a command that exited 0 before the node failed for another reason, such as a missing output), `deps` (the node's own dependencies that failed or were skipped, joined by `, ` and followed by `also failed`; only when there are some) and `rerun`.
- `::warning` lines are removed from the block and printed after it.

**The footer** appears once the run is 500 ms old, counted from the first dispatch, and is redrawn every 100 ms. A run made only of cache hits finishes before it ever shows. Its rows:

- One row per node in flight (dispatched or running, not waiting for a slot), earliest first: spinner, name, its clock, `/ ~<last run>` when `last-run.json` knows the node, then the node's **latest line** dimmed. A node dispatched whose action has not started shows `checking cache`, since dagraph looks a cacheable node up in the cache first, or `starting` for a node that is not cacheable, such as a task that declares no inputs or a post step, whose cache dagraph never checks. The latest line is the line the command is printing now, or else the last non-blank line it ended. A `::warning` or `::debug::` line is never shown as the latest line.
- When more nodes run than fit, `+N more running`.
- Up to two waiting nodes, those queued first: `· c queued` (the scheduler holds it back: its deps have settled, but it has not been let run) or `· docs waits on lint` (pending dependencies, two named then `+N`). Why the scheduler holds a node back is the scheduler's own business, so the footer does not say; it reads only the run's node states, and holds for any scheduler.
- The status row: `[settled/total ✖︎failed] N running · M queued · ctrl-c cancels`. During a cancel: `cancelling: waiting for N running · ctrl-c again to force`.

Size rules: the footer is at most 72 columns wide (and at most the window width less one, at least 10). It has at most 8 rows and at most half the window's rows. The footer is the one place a node name is cut, with `…`.

Example footer, 40 columns, `maxParallelism: 2`:

```
⠦ lint      0.6s  src/parse.ts ok
⠦ typecheck 0.6s  [====== ] 60%
· test      queued
· docs      waits on lint
[0/4] 2 running · 1 queued · ctrl-c ca…
```

**Other writes.** What the workflow file prints while the graph is built passes straight through. Once the run has begun, other writes to stdout and stderr are held and printed into the scrollback above the footer, each on a line of its own, so the footer never erases them. Held writes to stderr come out on stdout, so `2>file` does not separate them until the recap has printed and the streams are given back. Writes that start with `::debug::` are dropped. The footer redraws without flicker or stale rows, even when the window is resized or Ctrl-C is echoed.

At the end, the footer is erased, the recap is printed with the hint `   (hand this to an agent)` after the report path, and stdout and stderr are given back.

**Limits of the footer.** What the footer assumes of the terminal, and where it stops:

- Each redraw is a single write wrapped in the synchronized-update sequence (`ESC[?2026h` … `ESC[?2026l`), and the footer's rows are written with line wrap off (`ESC[?7l` … `ESC[?7h`), ending in a carriage return. A terminal that does not implement synchronized updates gets the same bytes without that guarantee. A row the tool measures too narrow is clipped at the window's edge instead of wrapping.
- Widths are measured with `string-width`. Format characters (Unicode category Cf, such as zero-width joiners) are removed from a node's latest line and tabs become one space, because a terminal and `string-width` disagree on their width. Other characters a terminal draws wider or narrower than `string-width` says can still misplace the footer by a line.
- The window size is read from stdout (`columns`, `rows`) at each redraw. Without one, as when `live` is forced into a pipe, it is taken as 80 × 24. The footer's erase counts the lines each earlier row now takes, so a window made narrower does not leave stale rows.
- A command cannot prompt: its stdin is the null device (`/dev/null`), so a read gets end of file at once, and it has no terminal ([dagworkflows-workflows](dagworkflows-workflows.md), "Command tasks"), so the footer never competes with a question. Only what the workflow file itself does while the graph is built, before the footer appears, reaches the terminal directly.
- Everything written to stdout and stderr during the run, by anyone in the process, is held and printed above the footer; `::debug::` writes are dropped.

Where it lives: `src/local/terminal/live.ts`, `src/local/terminal/frame.ts`, `src/local/terminal/blocks.ts`, `src/config.ts`.

## The `failures` style

An agent's view. It appends only and prints no colours or links. It prints failures and warnings, and nothing about nodes that succeeded.

- The first line is the banner title followed by ` · report .dag/failures.md`.
- The first 3 failures are printed as failure blocks (as in `live`). Their log tails share a budget of 4,000 characters, so a later block shows fewer lines. Each failure after the third is one line: `✖︎ <name>   <detail>   <log file>`.
- Each node's warnings: its first 3, then `N more warnings in <log file>`. Warnings have their own budget of 1,000 characters for the run, so they never take a failure block's room.
- The titles, failure blocks, one-line failures and host lines (such as `summary: <path>` and dagworkflows' own `[warning] dag: …` and `[notice] dag: …`) share a budget of 7,000 characters. Warnings are not part of it. The recap and the forced-exit line are outside both budgets. Once a line does not fit a budget, it and every later line on that budget are counted and left out, even a shorter one.
- The recap always prints. It names the first 3 failures and then `✖︎ N more, in the report`. Then it may add `N lines left out · all of it in .dag/failures.md` and `N warning lines left out · each in its node's log in .dag/logs/`. It always ends with `style: failures · every node's log inline: --output-style=grouped`.

A run of 61 nodes in which 30 tests fail stays under 10,000 characters.

Where it lives: `src/local/terminal/agent.ts`, `src/config.ts`.

## The `grouped` style

GitHub's renderer drawn on the local host. Each settled node is a block: `▶ <title>` followed by its log lines indented four spaces. A node that starts prints `▷ <name>`, with ` (last run 2.0s)` when the last run is known. A failure adds an `[error] <name>: <message>` line. The one change from GitHub is warnings: each `::warning` line of a log is replaced in place by `[warning] <node>: <message>`.

A run of the example workflow from "Warnings", in the `grouped` style, after an earlier run recorded durations (so the start lines show `(last run …)`):

```
▶ ci.ts · ref=refs/heads/master · 2 nodes
    lint
    upload
▷ lint (last run 7ms)
▶ ✖︎ lint (7ms)
    checking src
    [warning] lint: old flag
    ── error ──
    its shell command exited 1
[error] lint: its shell command exited 1
▷ upload (last run 1ms)
▶ ✔︎ upload (1ms)
    uploading
    [warning] upload: no files
summary: .dag/summary.md

✖︎ lint failed · ci.ts · built 1 · cached 0 · failed 1 · skipped 0 · wall 9ms
failed: lint
reproduce: npx --no dag run ci.ts --only lint
```

The banner's `ref=` shows the checkout's branch, and the durations vary from run to run.

The recap here is GitHub's (see "GitHub's log"). Locally the workflow file in the `reproduce` line is shell-quoted: `npx --no dag run 'ci flows.ts' --only lint`.

`dag post` run locally draws the same way, but leaves `::warning` lines as they are and writes no log files or failures report.

Where it lives: `src/local/session.ts`, `src/ports/local.ts`.

## The local recap

The `live` and `failures` styles end with a recap. This one is the `failures` style's:

```

✖︎ lint, require-all, upload and 1 more failed · ci.ts · wall 0.0s
built 2 · cached 0 · failed 4 · skipped 1

✖︎ lint          exit 1 · 0.0s · 72 lines   .dag/logs/lint.log
✖︎ require-all   0.0s   .dag/logs/require-all.log
  ⏭︎ deploy:site skipped because of it
✖︎ upload        exit 3 · 0.0s · 1 line   .dag/logs/upload.log
✖︎ 1 more, in the report

rerun    npx --no dag run ci.ts --only lint,require-all,upload,pack
report   .dag/failures.md
logs     .dag/logs/
style: failures · every node's log inline: --output-style=grouped
```

- In `live`, the recap ends at `logs`, with no `style:` line, and `report` carries the hint `   (hand this to an agent)`. Only the `failures` style adds the `N lines left out` lines and the `style:` line, and it has no hint.
- The headline, the workflow file and the wall time come first. The counts line comes next, once a node has settled.
- Each failure gets a line. Under it are the nodes it brought down, up to 5 names and then `+N`: `⏭︎ s1, s2, s3, s4, s5 +1 skipped because of it`.
- `rerun` reruns every failure. The list is shell-quoted when needed (`--only 'lint docs'`).
- `report` appears only when there is a failure or the run errored. `logs` always appears.
- A run that succeeded prints only the headline, the counts and `logs`.
- A run that threw before any node ran prints `✖︎ errored: bad config · ci.ts`, then `report` and `logs`.
- A **forced exit** is a second Ctrl-C, after which the process exits at once. It prints `◼︎ forced exit while build ran · report .dag/failures.md` instead of a recap.

Before the recap, each pass's summary write prints `summary: .dag/summary.md`.

Where it lives: `src/local/terminal/blocks.ts`, `src/local/words.ts`.

## Log files

Every local style writes each node's log to `<log dir>/<node>.log`. The files are written as output arrives, so `tail -F .dag/logs/lint.log` follows a running node.

- **Paths.** Each `:` or `/` in a node name is a directory level: `test:a` goes to `.dag/logs/test/a.log`, and `packages/pkg0:test` goes to `.dag/logs/packages/pkg0/test.log`. A `.` or `..` segment is encoded as `%2E` (`../up` goes to `.dag/logs/%2E%2E/up.log`), so no name escapes the directory. A name made only of separators is URL-encoded (`:` goes to `.dag/logs/%3A.log`). Empty segments are dropped (`/abs` goes to `.dag/logs/abs.log`). So names that differ only in `:` versus `/`, or in repeated or leading separators (`test:a`, `test/a`, `test::a`), share one log file, and the later writer overwrites it.
- **Content.** The file holds plain lines: escape codes and control characters removed, each line as a terminal leaves it after carriage returns, and `::debug::` lines dropped. Blank lines are kept. A `::warning` line stays as written. The node's error is not written to it, only what the node printed, so a node that failed without printing has an empty file: `require-all` failing with `failed: flaky`, or a `shell` task `exit 3` (verified).
- **When.** A node's file is emptied when its start comes, and each completed line is appended. A node that printed nothing as it ran, such as a cache hit, gets its file from the CAS log at its settle: a cache hit's file holds the log of the run that built it. A node skipped, or one that failed or was cancelled before its start came, gets no file; one whose start came but whose action did not run keeps the empty file. At a forced exit, the unfinished line of each running node is appended.
- Files of nodes that are not part of this run are left alone.
- **Errors.** Writes are synchronous, so files are whole when the process is forced out. The first write that fails prints the warning `[warning] dag: log files off: <error>`, and the log files stop for that run. The run goes on.

Where it lives: `src/local/recorders/log-files.ts`, `src/local/recorders/writer.ts`.

## The failures report, `failures.md`

A markdown file for a person or an agent to fix the run from. It uses the own-failure rule. It is rewritten when each pass begins, whenever a node fails or is skipped, when the run ends and at a forced exit. So mid-run it already shows what has failed.

A finished run with one failure:

````
# Failures · ci.ts

status: finished · started 2026-10-25T17:13:30.381Z · wall 0.0s
✖︎ lint failed · built 2 · cached 0 · failed 1 · skipped 0

## ✖︎ lint · exit 1 · 0.0s · 2 lines

- command: `lint` (cwd `.`)
- log: `.dag/logs/lint.log` (2 lines)
- rerun: `npx --no dag run ci.ts --only lint`

```text
checking src
::warning title=lint::old flag
```

Logs: .dag/logs/ · summary: .dag/summary.md
````

The head depends on the run's lifecycle:

| Lifecycle                     | Head                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `running`, `cancelling`       | `status: running · started <ISO time>`, then `No failures so far.` if none.                                                                         |
| `finished`, `cancelled`       | The status line with `wall`, the outcome line (headline and counts), then `No failures.` if none.                                                   |
| `errored`                     | The status line, `✖︎ errored: <first line>`, and the whole error in a fenced block.                                                                  |
| `interrupted` (a forced exit) | The status line without wall time, the outcome line, then `A forced exit stopped the run while `build` ran.` (or `A forced exit stopped the run.`). |

`started` appears once a node has started.

Each failure has a section `## ✖︎ <name> · <detail>` with these bullets, each only when it applies. The detail is the failure block's header, so a node that failed before its action ran reads `## ✖︎ lint · not started` and has no `log:` bullet:

- `command:` the last command the node ran, shell-quoted, with its cwd, as in the `cmd` row;
- `error:` the error on one line, left out when it only repeats the exit code (by the same rule as the terminal: its `CommandCause` `exited` with a non-zero code and it did not time out);
- `log:` the log file and its line count;
- `dependencies that also failed:`;
- `skipped because of it:`;
- `rerun:` the command that reruns this node alone.

After the bullets comes the last 60 lines of its log, as plain text but not cut at 500 characters, in a fence. Inline code and fences use more backticks than any run of backticks in their content, so a log or command holding ` `` ` is shown intact. The file ends with `Logs: <log dir>/ · summary: <summary file>`.

If the report cannot be written, the warning `[warning] dag: failures report off: <error>` prints once and the report stops for that run.

Where it lives: `src/local/recorders/failures-report.ts`.

## Where logs are kept: the CAS log

Every task records its log, stdout and stderr interleaved as they arrived, plus its `log()` and `warn()` lines. When its action ends, failed or not, the task writes the log to `<cas dir>.logs/<action key>.log` (`.dag/cas.logs/…` by default). The file is renamed into place, so no reader sees half a log. `logPath(casBaseDir, actionKey)` returns the path.

- The log is keyed by the action key. A cache hit has the key of the run that built it, so it shows that run's log, on GitHub and locally, where that log is on disk.
- A missing log reads as empty, never as an error, so a hit whose log is not on this machine shows an empty log: on GitHub, an empty group `✔︎ <name> (cached)`. That is every hit on a fresh runner whose CAS came from GitHub's cache, because the cache's `path` is the CAS directory (`.dag/cas`) and the logs are beside it. A `path` that listed `<cas dir>.logs/` too would carry them, unmasked, into a cache any pull request can restore. Verified with the CLI in GitHub mode: after `.dag/cas.logs/` was deleted, a run whose one node was a hit printed `::group::✔︎ build (cached)` and `::endgroup::` with no line between, and exited 0. Whether the empty group is intended is an open question.
- The log is kept **beside** the CAS, not in it. The CAS is what a workflow saves to GitHub's cache, which any pull request can restore, and nothing masks what a command printed (see "Secrets and masking").
- Every output reads the logs back from here: GitHub's groups, the summary's failure blocks and the terminal's failure blocks. When read back, only the end of the log is trimmed: trailing blank lines and the last line's trailing whitespace. A line is dropped when it starts with `::debug::` exactly, so a tool's debug commands do not reach any output, not even on GitHub. An indented or escape-prefixed debug command is kept.

Where it lives: `src/step-records.ts`, `src/task.ts`, `src/kernel/store.ts`.

## GitHub's log

On GitHub, output goes through `@actions/core`: log groups, plain lines and annotations.

1. The banner, as a group titled for example `ci.ts · ref=refs/pull/7/merge · 3 nodes`, holding the node names. A post pass that owes something has the banner `post · N of M post steps owed`. A post pass that owes nothing prints nothing.
2. When a node starts: `▷ <name>`, with ` (last run 3.0s)` when the store has read `last-run.json` and it knows the node. On GitHub the store reads the file only once the first node settles, so nodes that start before any settle print a bare `▷ <name>` even when the file knows them. A node's start is its `start` event. A cache hit never starts, so it has no start line, and neither has a node that failed or was cancelled before its start came. A node cancelled in the instant after its start, or whose start the run's history could not record, has a start line, yet its action never ran.
3. When a node settles:
   - built: a group `✔︎ <name> (1.0s)` holding its log;
   - cache hit: a group `✔︎ <name> (cached)` holding the log of the run that built it, or nothing when that log is not on this runner (see "Where logs are kept: the CAS log");
   - failed: a group `✖︎ <name> (1.0s)` holding its log, then `── error ──`, then the error's lines. Then an error annotation titled with the node's name, whose message is the error. A node that failed before its action ran, such as a task whose `file()` input does not exist, or whose start the run's history could not record, has `(not started)` in place of its duration and no log: its group holds `── error ──` and the error (`ENOENT: src/a.ts`). Its result's `elapsed` says which;
   - skipped: the line `⏭︎ <name>: skipped, dependency <dep> failed`;
   - cancelled once its action ran: a group `◼︎ <name> (cancelled)` with what it printed; cancelled before, even after its key lookup or its start: the line `◼︎ <name>: cancelled`. Its result's `elapsed` says which.
4. The recap, after a blank line and outside any group:

```
✖︎ lint failed · ci.ts · built 0 · cached 0 · failed 1 · skipped 0 · cancelled 2 · wall 4.0s
failed: lint
cancelled: slow, after
reproduce: npx --no dag run ci.ts --only lint
```

The first line is the headline, the run's title, the counts and the wall time. Then come `failed:`, `skipped, dependency failed:` and `cancelled:` lines, each only when it has names. Last comes `reproduce:` with the failures, the list shell-quoted when needed (`--only 'lint docs'`), when there are any and the pass knows its rerun command (`dag run` and the action always do for the run). A post pass's recap names `<workflow file> · post` and never has a `reproduce:` line.

Nodes settle in groups printed whole at the settle, so parallel nodes never interleave. A node's group is printed when it settles, not as it runs.

**Lines a command prints are replayed into the group** as the runner reads a `run:` step's output. GitHub's runner then reads the workflow commands in them: `::warning`, `::error` and `::add-mask::`. Two adjustments keep one node from breaking the next:

- GitHub does not nest groups. A tool's own `::group::<title>` inside a node's log becomes the plain line `<title>`, and `::endgroup::` is dropped.
- A `::stop-commands::<token>` that a log leaves open would turn off command processing for every later node in the step. The group therefore prints `::<token>::` before it ends, to resume commands.

`summary` with `GITHUB_STEP_SUMMARY` unset prints the summary markdown into the log.

Where it lives: `src/github/renderer.ts`, `src/ports/github.ts`.

## Check runs

On GitHub, each node gets a check run, named after the node, in the pull request's Checks tab.

- **On.** Check runs need the environment variable `GITHUB_TOKEN` in the step's environment and the `checks: write` permission. Without a token they are off with no message. The first API call that fails turns them off for the rest of the process. It posts the notice `check runs disabled: <error>` (titled `dag`) and never fails the build.
- **Target.** On `pull_request` events, the check runs target the pull request's head commit, not the merge commit in `GITHUB_SHA`, so they show on the pull request. Otherwise they target the context's sha.
- **Lifecycle.** A node whose start comes gets a check run created `in_progress`, with `started_at`. At its settle the check run is updated to `completed`. A node that never started (a cache hit, a skipped node, or one that failed or was cancelled before its start came) gets a check run created directly as `completed`. The completed check run's `started_at` is the node's start: its start's time once its action ran, or a cache hit's dispatch. A skipped node, or one that failed or was cancelled before its action ran, has no `started_at` there.
- **Conclusion.**

  | Node status      | Conclusion                              |
  | ---------------- | --------------------------------------- |
  | `done`, `cached` | `success`                               |
  | `failed`         | `failure`, or `timed_out` for a timeout |
  | `dep-failed`     | `skipped`                               |
  | `cancelled`      | `cancelled`                             |

- **Text.** The summary is one line of status: `done in 1.2s`, `cached`, `cancelled`, or the error message for a failed or skipped node (`dependency typecheck failed`). The title is `<name>: <first line of the summary>`. The summary keeps at most its last 65,000 characters, because GitHub refuses more than 65,535. A link to the run's log follows it, after a blank line: `[run log](https://github.com/<owner>/<repo>/actions/runs/<run id>)`. GitHub gives a check run made by the Actions token its own details page, whatever is sent, so the link to the log goes in the summary.
- A check run carries no log.
- **Ordering.** Check run updates are queued one after another, so they never hold up the log. The pass's end waits for the queue to drain.
- Locally, check runs do nothing.

Where it lives: `src/ports/github.ts` (`createGithubHost`), `src/github/renderer.ts`.

## The step summary

At the end of each pass, the step summary is drawn and handed to the host. On GitHub it is added to `$GITHUB_STEP_SUMMARY`. Locally it goes to the summary file. The summary is built from **renderers**: functions that each draw one block from the pass's data.

**Assembly.** The summary is `## <title>`, then each renderer's block that is not empty, separated by blank lines, ending in a newline. The title is the pass's: the workflow file (`run` when there is none) for the run, and `<workflow file> · post` for a post pass, so a post pass's summary appended locally reads `## ci.ts · post`. If every renderer returns `[]`, the summary is empty; `summary: []` turns it off this way. An empty summary is still handed to the host: locally that leaves an empty `.dag/summary.md` (on a process's first summary), still announced with `summary: <path>`. On GitHub nothing is added to `$GITHUB_STEP_SUMMARY`, and with that variable unset an empty line is printed. The data is a `RunReport`: the pass's settled nodes in graph order (which is topological), and `log(name)`. `log(name)` returns a node's log as its GitHub group prints it: the CAS log, and for a failed node `── error ──` and the error; for a skipped node, its message. In a post pass the report holds only the owed post steps.

**A renderer that throws** does not break the summary or the run. In its place the summary shows `_(<name> failed: <message>)_`, where `<name>` is the function's name, or `#<n>`, its 1-based place in the list (for example `#2`), when it has none. An arrow function assigned to a `const` is named after the const, so only an inline anonymous function gets a number. A warning annotation titled `dag` says `step summary: <name> failed: <message>`.

**Size budget.** GitHub caps a step summary at 1 MiB. The summary is kept within 900,000 UTF-8 bytes. When it is over, first every fenced ` ```text ` log block is replaced by `_(log omitted: summary over the 1 MiB budget)_`. Then, from the top, each block that no longer fits is replaced by `_(<name> omitted: summary over the 1 MiB budget)_`. The renderers listed first keep their room.

**Locally**, the summary file is overwritten by a process's first summary, and later passes in the same process append to it, as `$GITHUB_STEP_SUMMARY` does. A post pass's summary thus follows the run's. Escape codes are stripped from the file. Each write prints `summary: <path>`.

### The built-in renderers

| Renderer             | Draws                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderStatus`       | `### <headline>`, then one line: the counts in bold, `wall`, `parallelism N.N×` (busy time, the durations of the nodes whose action ran to its end: built, or failed once it ran; over wall time, when wall > 0), `cache H/L hits` (hits over hits plus builds, when there were any), with `, X saved` (the cache hits' last-run durations) when known.                                                                                                                                                                                                                                                                                                                           |
| `renderTimeline`     | A mermaid `gantt` of the nodes whose action ran to its end (`done`, and `failed` once its action ran), sorted by name, `:` in names shown as `/`, failures marked `crit`. Nothing if no node ran.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `renderCriticalPath` | `critical path: build → test (5.0s)`: the longest chain by duration through the graph, counting only nodes of 1 s or more. Nothing if no node took that long.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `renderDag`          | The graph as a mermaid `flowchart LR`. Each node is labelled with its status icon and full name and coloured by status (`done`, `cached`, `fail`; skipped and cancelled share `skipped`). `settled` dependencies are drawn dotted (`-.->`). Dependencies outside the given nodes are left out, so a filtered report draws. Above 60 nodes it draws one box per node `kind` with counts, for example `run ×35: ✔︎34 ✖︎1`, because GitHub refuses very large diagrams. Every `cmd` task has the kind `run` and every `shell` task `run-shell`, while an `action` task's kind is its name, so each action task keeps a box of its own and a graph made mostly of them does not shrink. |
| `renderFailures`     | `### failures`, then for each failed node a collapsed `<details><summary>✖︎ <name> (3.0s)</summary>` (`(not started)` for one whose result has no `elapsed`) holding the last 60 lines of `log(name)` in a ` ```text ` block, and for each skipped or cancelled node a line `- ⏭︎ deploy: skipped, dependency failed` or `- ◼︎ x: cancelled`. Graph order, so a cause comes before what it broke. Nothing if every node succeeded.                                                                                                                                                                                                                                                  |
| `renderTable`        | A table `\| node \| status \| duration \| vs last \|`, sorted by name. `vs last` is the change against the last run for built nodes (`+100%`, `-20%`, `±0%`). Not in the defaults.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

A default summary for a run where `a` was built, `b` was a cache hit, `c` failed and `d` was skipped:

````
## run

### ✖︎ c failed

built **1** · cached **1** · failed **1** · skipped **1** · wall 6.0s · parallelism 0.3× · cache 1/2 hits, 2.0s saved

```mermaid
gantt
  …
```

critical path: a → c (2.0s)

```mermaid
flowchart LR
  …
```

### failures

<details><summary>✖︎ c (1.0s)</summary>

```text
boom
── error ──
exit 1
last line
```

</details>

- ⏭︎ d: skipped, dependency failed
````

### Choosing and writing renderers

A workflow sets `summary` to its list of renderers, top to bottom. To put the table back at the bottom, use `[...DEFAULT_SUMMARY_RENDERERS, renderTable]`. To draw part of the graph, pass a built-in a filtered report. This workflow file runs as shown and adds a "slowest" block, a graph of the tests alone, and the table:

```ts
import {
  DEFAULT_SUMMARY_RENDERERS,
  defineWorkflow,
  formatDuration,
  renderDag,
  renderTable,
  type SummaryRenderer,
} from "@mrmeku/dagworkflows";

const slowest: SummaryRenderer = ({ nodes }) => {
  const timed = nodes.filter((report) => report.duration !== undefined);
  if (timed.length === 0) return [];
  const top = timed.toSorted((a, b) => (b.duration ?? 0) - (a.duration ?? 0)).slice(0, 3);
  return [
    "### slowest",
    "",
    ...top.map(({ node, duration }) => `- ${node.name}: ${formatDuration(duration ?? 0)}`),
  ];
};

const testsOnly: SummaryRenderer = (report) =>
  renderDag({ ...report, nodes: report.nodes.filter(({ node }) => node.name.startsWith("test:")) });

export default defineWorkflow({
  summary: [...DEFAULT_SUMMARY_RENDERERS, slowest, testsOnly, renderTable],
  implementation: (workflow) => {
    const build = workflow.task({
      name: "build",
      shell: "sleep 0.2; echo built",
      cacheable: false,
    });
    workflow.task({
      name: "test:unit",
      cmd: ["echo", "unit ok"],
      deps: { build },
      cacheable: false,
    });
    workflow.task({ name: "test:e2e", cmd: ["echo", "e2e ok"], deps: { build }, cacheable: false });
  },
});
```

The `slowest` block it produced:

```
### slowest

- build: 216ms
- test:unit: 5ms
- test:e2e: 4ms
```

Rules for a renderer:

- It returns markdown lines. `[]` leaves no block and no blank line.
- It may be async. It may read any node's log with `await report.log(name)`.
- A ` ```text ` fence in its output counts as a log block, which the budget drops first.
- It cannot change the run's outcome. A renderer that throws shows a note and a warning.
- Give it a named function, so that notes and warnings name it.

`NodeReport` fields: `node`, the graph's node (`name`, `kind`, `deps`, `settledDeps?`, `concurrencyGroup?`, `cacheable?`, `timeoutMs?`, `meta?`); `result`, dagraph's `Result` as it is, so `result.status`, a failure's `result.error`, a built or cached node's `result.outputs` (paths into the CAS), a skipped node's `result.rootCauses`; `start?` (epoch ms its `start` came, for a node whose action ran, or a cache hit's dispatch; absent for any other node); `duration?` (as "Durations" says); and `previous?` (its duration in `last-run.json`). A renderer that wants dagworkflows' words for a failure calls `failureMessage({ node, result })` once `result.status` is `failed` or `dep-failed`.

Where it lives: `src/summary.ts`, `src/reporter.ts`, `src/ports/local.ts` (summary file), `src/config.ts`.

## Warnings

A warning is something worth reading in a node that did not fail. It is a line in the node's log, in the form of GitHub's workflow command: `::warning title=<title>::<message>`.

**Sources.**

- A function task calls `warn(message)`. It writes `::warning title=<node name>::<message>` to the node's log, with `%`, carriage return and newline escaped (`%25`, `%0D`, `%0A`), and `:` and `,` also escaped in the title.
- Built-in steps use the same `warn`: a cache restore or save that the store refuses (`Failed to restore: …`, `Failed to save: …`) and an artifact upload with no files when `ifNoFilesFound` is `"warn"` (the default). These belong to [dagworkflows-cache-artifacts](dagworkflows-cache-artifacts.md).
- Any command that prints a `::warning` line.

**Which lines are warnings.** A line is read as GitHub's runner reads it: leading whitespace is ignored (including U+0085), the command name is matched in any case (`::WARNING …::` counts), properties such as `file=` and `line=` are ignored, and the message is unescaped. A line that does not start with the command (`echo ::warning::x` printed literally) is not a warning. Between `::stop-commands::<token>` and `::<token>::`, no line is a warning.

**What each output does with them.**

| Output                                                 | Shows                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub log                                             | The line as written, which the runner turns into a warning annotation with its title.                                                                                                                                                                                               |
| `grouped`                                              | Each warning line replaced in place by `[warning] <node>: <message>`. A message with newlines spans several lines.                                                                                                                                                                  |
| `live`, `failures`                                     | The node's warnings after its line or failure block, each `[warning] <node>: <message>`, plain, cut at 500 characters. Removed from the failure block's tail. A cache hit's warnings, from the log of the run that built it, print too. In `live` they follow the `✔︎ cached:` line. |
| `live` footer                                          | Never shows a warning as a node's latest line.                                                                                                                                                                                                                                      |
| Log files, `failures.md` tails, summary failure blocks | The raw `::warning` line.                                                                                                                                                                                                                                                           |

The terminal label is always the node's name, not the command's `title=`.

dagworkflows also raises its own warnings and notices on the host, titled `dag`: `step summary: <renderer> failed: <message>`, `log files off: <error>`, `failures report off: <error>`, and the notice `check runs disabled: <error>`. [dagworkflows-lifecycle](dagworkflows-lifecycle.md) adds a warning for an unreadable run history, and [dagworkflows-cache-artifacts](dagworkflows-cache-artifacts.md) adds notices when the cache or artifact services are off. Locally these print as `[warning] dag: …` or `[notice] dag: …`.

Example. This workflow's `lint` prints a warning and fails. `upload` runs after it anyway and warns:

```ts
import { defineWorkflow, settled } from "@mrmeku/dagworkflows";

export default defineWorkflow({
  implementation: (workflow) => {
    const lint = workflow.task({
      name: "lint",
      shell: "echo checking src; echo '::warning title=lint::old flag'; exit 1",
      cacheable: false,
    });
    workflow.task({
      name: "upload",
      deps: { lint: settled(lint) },
      action: ({ log, warn }) => {
        log("uploading");
        warn("no files");
      },
    });
  },
});
```

In the `failures` style the run prints (the banner shows the ref of the checkout it ran in):

```
ci.ts · ref=refs/heads/master · 2 nodes · report .dag/failures.md
✖︎ lint  exit 1 · 0.0s · 2 lines
│ checking src
├ log    .dag/logs/lint.log
├ cmd    bash --noprofile --norc -eo pipefail -c 'echo checking src; echo '"'"'::warning title=lint::old flag'"'"'; exit 1'   (cwd .)
└ rerun  npx --no dag run ci.ts --only lint
[warning] lint: old flag
[warning] upload: no files
summary: .dag/summary.md

✖︎ lint failed · ci.ts · wall 0.0s
built 1 · cached 0 · failed 1 · skipped 0

✖︎ lint   exit 1 · 0.0s · 2 lines   .dag/logs/lint.log

rerun    npx --no dag run ci.ts --only lint
report   .dag/failures.md
logs     .dag/logs/
style: failures · every node's log inline: --output-style=grouped
```

A warning line counts in the node's line count (`2 lines`).

Where it lives: `src/kernel/format.ts`, `src/step-records.ts`, `src/task.ts` (`warn`), `src/local/words.ts`, `src/local/session.ts`.

## Secrets and masking

**What a command can see.** Every command inherits the whole environment of the `dag` process, with its own `env` set on top. Nothing is filtered. On GitHub this includes every variable the step sets (for example `GITHUB_TOKEN` when the step passes it for check runs) and the runner's own. Under the GitHub Action, it also includes the action's inputs (`INPUT_*`) and the credentials only a JavaScript action receives, such as `ACTIONS_RUNTIME_TOKEN` and the cache service URL. Any task can read any of these. The action imports the `workflow` file from the working directory, which is the checked-out tree, so in a job that checks out a pull request, the workflow file and every task it adds are that pull request's code, running with whatever the step's `env` holds. Give a step only the secrets you would hand to the code it checks out.

**Where logs go.**

| Place                                               | Masked?                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub job log (groups, annotations, recap)         | Yes, by GitHub's runner, for the values it knows.                                                                                                                                                                                                                                         |
| Check runs (title and summary)                      | No. They are sent through the API, which the runner does not mask. They carry no log, only a status line or the error message, and a link to the run's log.                                                                                                                               |
| GitHub step summary                                 | dagworkflows masks nothing in it. It holds the last 60 lines of each failed node's log, ending with its error under `── error ──`. GitHub's docs state that summaries automatically mask any secrets added by accident, and that deleting the workflow run removes all its job summaries. |
| `<cas dir>.logs/`                                   | No. The raw log of every node, on the runner's or the developer's disk.                                                                                                                                                                                                                   |
| `.dag/logs/`, `.dag/failures.md`, `.dag/summary.md` | No. Nothing masks local output.                                                                                                                                                                                                                                                           |
| The CAS directory                                   | No log is written there.                                                                                                                                                                                                                                                                  |

**Why the logs are not in the CAS.** A workflow saves the CAS to GitHub's cache, and a cache saved on one branch can be restored by any pull request. Logs are unmasked, so they are kept in a sibling directory. Saving the CAS directory (`.dag/cas`) carries no log. Saving a parent such as `.dag` would carry `.dag/cas.logs/` and `.dag/history/` with it; the history holds the running run's results, with failed nodes' errors and their command's argv and cwd. On GitHub no local session runs, so there is no `.dag/logs/`, `.dag/failures.md` or `.dag/summary.md` to carry; a local `.dag` holds those too.

**How masking works on GitHub.** A node's log is replayed into the job log when the node settles, as if the step printed it. The runner masks the secrets it knows (the `secrets` context) and every value a line `::add-mask::<value>` registers. Limits:

- Any node can register a value with `::add-mask::`, not only the node that made it. The mask takes effect only when that node's group is printed, at its settle, and applies from that group onward. A value it printed earlier, or that another node printed in a group shown earlier, is not masked.
- Only the job log is masked. The raw CAS log, local files and check runs are not.
- A failure's error message can include the command's full argument list (`<argv> exited <code>`). That message goes to check runs unmasked, to the error annotation, to the node's GitHub group and to the step summary's failures section. The terminal and `failures.md` hide that message, since it says only the exit code, but their `cmd` row and `command:` bullet show the argv quoted shell-style instead, for example `bash -c 'exit 3' LITERALSECRET`. For a `shell` task the message is only `its shell command exited <code>`, while the `cmd` row and `failures.md` show the full bash line with the string as written. Pass secrets through the environment, not as arguments.
- A log that opens `::stop-commands::` gets commands resumed at the end of its group. A node cannot switch off command processing, and with it `::add-mask::`, for the nodes after it.

**Passing a secret.** Put it in the step's `env`, and let the command read it from the environment it inherits:

```yaml
- uses: mrmeku/dagworkflows@v1
  with:
    workflow: ci.ts
  env:
    GITHUB_TOKEN: ${{ github.token }}
    API_TOKEN: ${{ secrets.API_TOKEN }}
```

```ts
workflow.task({
  name: "deploy",
  deps: { pack },
  shell: 'curl -fsS -H "Authorization: Bearer $API_TOKEN" -T "$TARBALL" https://example.com/upload',
  env: ({ pack }) => ({ TARBALL: pack.tarball }),
});
```

The ref `@v1` is the consumer job's in [dagworkflows-cli-action-release](dagworkflows-cli-action-release.md), where the major the first release takes is still open. The task inherits `API_TOKEN` from the step; the workflow file never holds the value. A `shell` task records its command as the bash invocation with the string as written (`$API_TOKEN`, not its value), so the value stays out of the messages below. Keep a secret out of these places:

- `cmd` arguments, and literal values in a `shell` string: a `cmd` failure's message is `<argv joined by spaces> exited <code>` (the error annotation, the GitHub group, the step summary, check runs; the `cmd` row and `failures.md` show the argv shell-quoted instead), and the history file records the failed command's `argv` (for a shell task, the bash line with the string as written) in its error's `cause`.
- `inputs` and a static `env` value. They are not written into the CAS (an entry's `manifest.json` holds only its outputs and a content hash), but they become part of the task's key, so rotating the secret reruns the task.
- Declared outputs. An output file is the CAS, and the CAS is what a workflow saves to GitHub's cache.

The runner's own test pins the base case: a command that prints its token leaves no trace of it under the CAS directory.

**If a secret was printed.** Masking cannot be applied after the fact. The places dagworkflows itself has put what a command printed or was called with, to clean after rotating the secret:

- the job log on GitHub, unmasked for any value the runner did not know when the node's group was printed;
- check runs (their summary is the error message, which may hold the argv);
- the step summary (the last 60 lines of each failed node's log);
- `<cas dir>.logs/<action key>.log` on the machine that ran it. While that file is there, every later cache hit of that node replays it, into the terminal and, on a runner that has it, into the job log, where a rotated value is no longer masked. Deleting the file is safe: a cache hit with no log shows an empty log;
- locally `.dag/logs/`, `.dag/failures.md`, `.dag/summary.md`, and `.dag/history/*.json` (a failed command's argv);
- any GitHub cache entry whose `path` held one of these, such as a cache of `.dag` rather than `.dag/cas`.

Where it lives: `src/ports/real.ts` (`createExec`, env merge), `src/step-records.ts` (`logPath`), `src/kernel/store.ts` (a missing log reads as empty), `src/ports/github.ts`, `src/runner.test.ts` ("secrets").

## Drawing a run yourself

### `createReporter`, for a program that runs dagraph itself

`createReporter(ports, { casBaseDir, nodes, title?, rerunCommand?, summary? })` draws a run the way GitHub's renderer does, on `ports.host`, but with no banner group: only the start lines, the node groups, annotations, the recap, the summary and check runs. It keeps `<casBaseDir>/last-run.json` as `dag run` does.

- `nodes` is the graph's node list (dagraph's `graph.describe()`).
- `title` names the run in the summary heading and the recap. It defaults to `run`.
- `rerunCommand` adds the `reproduce:` line.
- `summary` sets the renderers. It defaults to `DEFAULT_SUMMARY_RENDERERS`.

It returns `{ onEvent, finish }`. Pass `onEvent` as dagraph `execute`'s `onEvent`. Every time it shows (durations, check runs' start and end, wall time) is one that `execute` stamped on its events, so pass `execute` a `clock` in its execution context (such as `ports.clock`) to control them: the reporter does not read `ports.clock`. Call `await finish(results)` with `execute`'s results. That prints the recap, publishes the summary, waits for check runs, and resolves to `{ failed, markdown }`. `failed` counts results that are neither `done` nor `cached`. Logs are read from beside `casBaseDir`, so tasks must write them there (dagworkflows tasks do).

### `createRunStore` and `RunListener`

`createRunStore({ fs, casBaseDir, listeners, lastRunAtBegin? })` is the store every output listens to. It reads no clock: every time it holds is one dagraph stamped on an event. Pass one as `store` in `RunOptions`, and `runWorkflow` reports to it instead of to GitHub's renderer. The host still gets the summary and dagworkflows' own annotations. Its methods:

- `begin(pass)` begins a pass.
- `onEvent(event)` takes an engine event, as dagraph emits it.
- `cancel()` marks the run as cancelling.
- `report(pass)` resolves to the pass's `NodeReport[]` once every settle has been told.
- `log(name)` returns a node's log as its group prints it.
- `finish(pass, reports)` calls each listener's `finish` in turn.
- `close(error?)` ends the run, as `finished`, `cancelled` or `errored`.
- `interrupt()` handles a forced exit.
- `getState()` returns the current `RunState`.
- `dispatch(action)` applies a `RunAction`.

`runJob` closes the store. A caller of `runWorkflow` closes it itself.

**`last-run.json` and `lastRunAtBegin`.** The store keeps `<casBaseDir>/last-run.json`. It reads the file lazily: before its first write, at the first settle of a node that built, or failed once its action ran, or at `report`. So without `lastRunAtBegin`, the first nodes to start have no `(last run …)` on their start line and no `/ ~<last run>` on their footer clock. With `lastRunAtBegin: true`, as the local session sets, the file is read as the first pass begins. An unreadable or malformed file counts as no last run, with no warning. When it writes, it merges this run's durations into the ones it read, so the durations of nodes outside this run are kept. The file sits inside the CAS directory, so saving the CAS carries it.

`RunListener` hooks, all optional:

- `begin(pass, run, isFirstPass)`, `start(nodeState, run)`, `settle(nodeState, run, log)` and `finish(pass, nodes)` come in the order things happened. A settle comes once the node's CAS log is read, and `run` is the state as of that moment. No pass begins ahead of the last pass's settles.
- `immediate.start(nodeState)` and `immediate.output(nodeState, lines)` fire at once, inside the engine's event and the command's output stream, ahead of settles still being read. Log files use them. A hook that throws fails the run as if an ordered hook had thrown, and the other listeners still hear the event.
- `close(run)` and `interrupt(run)` come last listener first, so the first listener has the last word. One that throws does not stop the others, and the first error is rethrown.

`RunState` is `{ nodes, lastRunDurations?, lifecycle }`. `lifecycle.status` is one of `running`, `cancelling`, `finished`, `cancelled`, `interrupted`, or `errored` with an `error`. A node's state is `pending`, `dispatched` or `running` (with `startedAt`), or a settled status with `result`, dagraph's `Result` for it as it is, and `endedAt`, when the result came. A settled state has `startedAt` when it was built, hit the cache, or failed or was cancelled once its action ran (its result has `elapsed`), and none otherwise. A failed node's state also has its `log`, and every settled state has `lineCount` once the store has read the CAS log; a listener's `settle` receives the state with both set. Every node state has `unfinishedLine`, `lastLine` and `printed`, which describe what the node has printed.

The `selectors` namespace queries the state: `isSettled`, `startedAtOf`, `actionRan(result)` (whether dagraph ran the node's action: its result has `elapsed`, a cancel that caught it running included), `ranToItsEnd(result)` (built, or failed once its action ran; not cancelled: the nodes whose duration `last-run.json` keeps and the summary counts as busy and draws), `logKeyOf` (the key whose CAS log holds what the node printed, none for a node whose action did not run, a cache hit aside), `durationOf`, `commandOf(error)` (the `CommandCause` a failure's error carries, if a command it ran failed), `nodesInFlight`, `runStartedAt`, `nodeReports`, `failedNodes`, `getDependencyFailures(run, nodeState)` (the deps that failed or were skipped), `causesOf(nodeState)` (a skipped node's `rootCauses`) and `skippedBecauseOf(run, name)`.

This script ran (with its imports pointed at the packages' sources) and prints one JSON line per settle:

```ts
import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";
import {
  createExec,
  createRunStore,
  defineWorkflow,
  nullArtifactStore,
  nullCacheStore,
  nullHost,
  runWorkflow,
  selectors,
  systemClock,
  type RunListener,
} from "@mrmeku/dagworkflows";
import { check, lock } from "proper-lockfile";

const jsonLines: RunListener = {
  settle: (nodeState, _run, log) =>
    console.log(
      JSON.stringify({
        node: nodeState.node.name,
        status: nodeState.status,
        lines: log.length,
        causes: selectors.causesOf(nodeState),
      }),
    ),
  close: (run) => console.log(JSON.stringify({ run: run.lifecycle.status })),
};

const { implementation } = defineWorkflow({
  implementation: (workflow) => {
    const lint = workflow.task({ name: "lint", shell: "echo bad; exit 1", cacheable: false });
    workflow.task({ name: "deploy", cmd: ["echo", "deployed"], deps: { lint } });
  },
});
const fs = createNodeDagFs();
const clock = systemClock();
const store = createRunStore({ fs, casBaseDir: ".dag/cas", listeners: [jsonLines] });
const outcome = await runWorkflow({
  implementation,
  workflowFile: "own.ts",
  casBaseDir: ".dag/cas",
  store,
  ports: {
    exec: createExec(),
    fs,
    clock,
    host: nullHost(),
    cacheStore: nullCacheStore,
    artifactStore: nullArtifactStore,
    lockfile: { lock, check },
    env: process.env,
  },
});
await store.close();
console.log(outcome.exitCode);
```

Output:

```
{"node":"lint","status":"failed","lines":1,"causes":[]}
{"node":"deploy","status":"dep-failed","lines":0,"causes":["lint"]}
{"run":"finished"}
1
```

### Hosts

A `Host` has six methods, which is all a host needs to implement:

- `context()` resolves to the `CiContext`: `ref`, `sha`, `eventName`, `actor`, `runId`, `repo` (`{ owner, repo }`) and `serverUrl`, as `@actions/github` names them, plus `isCi` and `provider`. The banner reads `ref`.
- `group(title, lines)` prints a log group: the banner and each settled node.
- `info(line)` prints a plain line: start lines, skipped and cancelled lines, the recap.
- `annotate(level, title, message)`, `level` being `error`, `warning` or `notice`: a failure's error, and dagworkflows' own warnings and notices.
- `summary(markdown)` publishes each pass's step summary.
- `check(update)` sends a node's check run. A `CheckUpdate` is `{ name, status: "in_progress" | "completed", conclusion?, startedAt?, completedAt?, summary? }`, the times as ISO strings and `summary` one line of status.

The local host's context is `provider: "local"`, `eventName: "local"`, `isCi: false`, `sha` from `git rev-parse HEAD`, `actor` from `git config user.name` or else `$USER`, `runId: 0`, and an empty `repo` and `serverUrl`. `nullHost()` gives `provider: "none"` and empty values. The recording host gives `provider: "recording"`, which its `context` argument can override.

- `createLocalHost({ exec, fs, summaryPath, write? })` prints groups as `▶ <title>` with lines indented four spaces, and annotations as `[level] title: message`. It writes the summary to `summaryPath` and does nothing for check runs. Its context comes from git: `ref` is `refs/heads/<branch>`, or `""` on a detached HEAD.
- `createGithubHost({ token?, fetch? })`, from `@mrmeku/dagworkflows/github`, is the GitHub host described above. `fetch` replaces Octokit's, for tests.
- `nullHost()` draws nothing.
- `createRecordingHost(context?)` records everything for tests.

Where it lives: `src/reporter.ts`, `src/kernel/store.ts`, `src/kernel/selectors.ts`, `src/ports/local.ts`, `src/ports/memory.ts`.

## Exit codes

`dag run` exits:

- `0` when every node was built or a cache hit;
- `1` when any node did not succeed (failed, skipped or cancelled);
- `130` after a cancel (Ctrl-C, SIGTERM or SIGHUP), as for a Ctrl-C.

A second signal exits at once with 130. When the workflow or the run throws, `dag run` prints the errored recap, then Node prints the error's stack trace on stderr, and the process exits 1. `dag post` exits 1 when an owed post step does not succeed. [dagworkflows-lifecycle](dagworkflows-lifecycle.md) and [dagworkflows-cli-action-release](dagworkflows-cli-action-release.md) own the details.

Where it lives: `src/runner.ts`, `src/cli.ts`.

## Open questions

- Under the action and `dag run` on GitHub, the workflow file in the `reproduce:` line is not shell-quoted; only the local session quotes it. The node names are quoted everywhere.
- Escape codes in log tails are stripped from the local summary file, but not from GitHub's step summary.
- `renderFailures` always fences a log with three backticks. A log line holding ` ``` ` would end the block early. `failures.md` picks a longer fence.
- `::warning` lines stay raw in log files, in `failures.md` tails and in the summary's failure blocks. Is that intended?
- Error messages, which can include a command's full arguments, go to check runs that the runner never masks.
- The comment on `Pass` says GitHub still opens a banner group for a post pass that owes nothing. `runPost` begins such a pass without a banner, so nothing is printed.
- `dag post` run locally prints through the GitHub renderer on the local host. It does not rewrite warnings and writes no log files or failures report, unlike `dag run`'s `grouped` style. Is that intended?
- The GitHub Action has no token input. Check runs need `GITHUB_TOKEN` set in the step's `env`.
- A CAS restored onto a fresh runner carries no logs, so each of its cache hits shows an empty group `✔︎ <name> (cached)`. The code makes both choices on purpose: the logs sit beside the CAS so that a cache carries nothing unmasked (`step-records.ts`), and a missing log reads as empty (`kernel/store.ts`). But no comment, test or plan says that an empty group is the result wanted, rather than, say, a line saying the log stayed on the machine that built it. Is it intended?
