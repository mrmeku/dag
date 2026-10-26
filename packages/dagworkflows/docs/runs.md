# Fix a failed run

A run is red when it exits 1, or 130 after a cancel. This page shows how to read what it printed and get back to green.

What a run prints depends on where you run it. In a terminal the style is `live`. Under an AI agent it is `failures`, which prints only failures. In CI or a pipe it is `grouped`, which prints every node's log as a block. `--output-style` picks one yourself.

## Read the recap

A run ends with a recap. This is the `failures` style's, for a run in which `install` and `build` were built, `lint` exited 1, `upload` ran after it and exited 3, and `pack` exited 0 without writing its declared output:

```
✖︎ lint, upload, pack failed · ci.ts · wall 0.0s
built 2 · cached 0 · failed 4 · skipped 1

✖︎ lint     exit 1 · 0.0s · 72 lines   .dag/logs/lint.log
  ✖︎ require-all failed because of it
  ⏭︎ deploy:site skipped because of it
✖︎ upload   exit 3 · 0.0s · 1 line   .dag/logs/upload.log
✖︎ pack     0.0s · 2 lines   .dag/logs/pack.log

rerun    npx --no dag run ci.ts --only lint,upload,pack
report   .dag/failures.md
logs     .dag/logs/
style: failures · every node's log inline: --output-style=grouped
```

Each name at the left margin is an own failure: a node that failed for a reason of its own. Those are what you fix. Indented under each are the nodes it brought down. `require-all` failed because of `lint` and `deploy:site` was skipped, and neither needs anything from you. The `rerun` line runs every own failure again.

Above the recap is a failure block for each own failure. This is `upload`'s:

```
✖︎ upload  exit 3 · 0.0s · 1 line
│ ECONNREFUSED 127.0.0.1:9000
├ log    .dag/logs/upload.log
├ cmd    upload   (cwd .)
├ deps   lint also failed
└ rerun  npx --no dag run ci.ts --only upload
```

The header says how the node ended, `exit 3` or `timed out`. Under it is the log, or its last lines when it is long. `cmd` is the last command the node ran, and `deps` names its dependencies that failed or were skipped. `rerun` reruns the node alone: `--only` runs the named nodes and everything they depend on.

`upload` depends on `settled(lint)`, so it ran although `lint` failed, then failed by its own command. That makes it an own failure but not a root failure. A root failure is a failed node none of whose dependencies failed or was skipped. GitHub's recap and the `grouped` style name only root failures, so there the same run reads `✖︎ lint, pack failed` ([What GitHub shows](github.md#what-github-shows)). Start with the root failures, because nothing upstream of them failed.

## Find the log

Each node's log is `.dag/logs/<node>.log`. Each `:` in a node name is a directory, so `test:unit` writes `.dag/logs/test/unit.log`. The file grows as output arrives, so `tail -F .dag/logs/lint.log` follows a node while it runs.

The failures report, `.dag/failures.md`, holds each own failure with its command, its log file, what it brought down and the line that reruns it. It is the file to hand an agent. Only a local `dag run` writes these files. On GitHub, a node's log is its group in the job log.

## A task ran, or did not, when you expected otherwise

The counts line says how many tasks ran (`built`) and how many came from the CAS (`cached`). To see which tasks hit, rerun with `--output-style=grouped`, where each hit gets a group such as `✔︎ build (cached)`. A hit shows the log of the run that built it, so output alone does not mean the command ran this time.

A task is cached on what it declares, and three causes explain most surprises:

- A task whose `inputs` hold no defined value, or only a glob that matched nothing, runs every time unless it sets `cacheable: true`.
- A file the command reads but does not declare reruns nothing when it changes. A command is keyed on its line, not on the program it runs, so put the program's files in `inputs`.
- A function task's code is not in its key, so bump a version value in its `inputs` when you change what it does.

The full rules are in [Inputs and when a task runs](workflows.md#inputs-and-when-a-task-runs). dagraph's checklist, [If a node reran, or did not](../../dagraph/docs/caching.md#if-a-node-reran-or-did-not), goes further.

## A post step failed, or an earlier run owes one

A post step is owed from the moment its task starts, whatever the task then does, and stays owed until it succeeds ([Post steps](workflows.md#post-steps)). It tries three times by default.

When every try fails, the run is red and its history stays behind in `.dag/history`. The next run of the same workflow file pays that debt before any task of its own. If the post step fails again, no task starts, because whatever it releases may still be there:

```
[error] dag: No task ran: post steps that an earlier run owes failed again (1), and what they release may still be there. Fix them and run again, or, once it is gone, remove that run's history in .dag/history.
```

Fix the post step, then pay it alone with `npx --no dag post ci.ts`, which runs only owed post steps.

If it cannot succeed, release by hand whatever it releases, then delete that run's history file. For a post step `down:db`, this finds the file:

```sh
jq -r --arg workflow "$(pwd -P)/ci.ts" --arg post down:db \
  'select(.workflow == $workflow and .results[$post].status == "failed") | input_filename' \
  .dag/history/*.json
```

On GitHub, the action's post entry pays what the run owes at the end of the job. It gives a post step that failed every try three more. When those fail, nothing ever pays the debt, because a GitHub-hosted runner is a new machine for every job and the next job does not find the history. Release by hand whatever the post step releases outside the runner. The failed job's log is the only record of what that is.

## The run was cancelled or timed out

The first Ctrl-C cancels the run. Nothing new starts, and each running command is interrupted. A command that was running settles `cancelled`, not failed, and so does every node that had not started. Then dag runs the post steps whose task had started. The run exits 130, and the next run runs the cancelled tasks, since a cancel is never cached.

A second Ctrl-C kills every running command and exits at once. It leaves the owed post steps to the next run or `dag post`. Under `npx` in a terminal, one Ctrl-C already reaches dag twice, so start `node_modules/.bin/dag` directly to get the orderly cancel.

A task with `timeoutMs` is interrupted the same way when its time is up, and fails whatever its exit code. Its failure block's header says `timed out`.
