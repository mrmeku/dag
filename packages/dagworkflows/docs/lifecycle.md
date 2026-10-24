# Lifecycle

dagworkflows starts, stops and cleans up tasks as GitHub does steps:

- A **post step** releases what its task set up. It runs after the task and the tasks that use it, whatever those tasks did.
- A **timeout** fails one task and lets the run continue.
- A **cancellation** stops all tasks, and then runs the post steps that the run owes.

## Post steps

A GitHub action has a `main` and a `post`. The `post` releases what the `main` set up, at the end of the job, also when the job fails. In dagworkflows, a task gives its post step as its `post` field. A post step has an `action`, a `cmd` or a `shell`, as a task has:

```typescript
const db = workflow.task({
  name: "up:db",
  cmd: ["docker", "run", "-d", "--name", "db", "postgres:16"],
  post: { name: "down:db", cmd: ["docker", "rm", "-f", "db"] },
});
workflow.task({ name: "test", cmd: ["pnpm", "test"], deps: { db, install } });
workflow.task({ name: "e2e", cmd: ["pnpm", "e2e"], deps: { db, install } });
```

A graph has no end of job. Thus a post step waits for its task, whatever the task did, and for each task that depends on its task, directly or through other tasks, whatever they did. `down:db` runs after `test` and `e2e`. You do not list these tasks, so a new task that uses `db` is never left out.

A post step is **owed** once its task started. dagworkflows records the start in the run's history before the task's command runs. A task that never started owes nothing: a dependency it requires did not succeed, or the cancellation came while it waited. Thus `down:db` runs when `up:db` failed after it started, and is skipped when `up:db` never started.

The post step gets its task's outputs as `main`. A task that failed or was stopped may not have written them. Thus a command reads them through `env`, where a missing output is unset, and an `action` gets `undefined`:

```typescript
const db = workflow.task({
  name: "up:db",
  cmd: ({ out }) => ["db", "start", "--pid-file", out.pid],
  outputs: { pid: "pid" },
  post: {
    name: "down:db",
    env: ({ main }) => ({ PID: main.pid }),
    shell: 'if [ -n "${PID:-}" ]; then db stop "$(cat "$PID")"; fi',
  },
});
```

These rules apply:

- A task with a post step is never cached, and takes no `inputs` or `cacheable`. A cache hit starts nothing, so it would leave nothing to release.
- A post step takes no `deps`. What it needs, its task depends on. Thus an owed post step can always run.
- No task depends on a post step, and a post step has no post step of its own.
- A post step never waits for the other post steps of its task.
- Post steps run in the reverse order of their tasks, as GitHub's do: when one task is upstream of another, the post steps of the downstream task run first.
- A post step must be safe to run twice, as `docker rm -f` is. A cancellation that stops it, or a failure, makes it run again.
- `--only` runs the named tasks and their dependencies, and the post steps of every task among those. A post step waits only for the tasks of the run. Thus `--only test` stops the database after `test`, and `--only up:db` starts the database and stops it at once.

### A post step that fails

A failed post step runs again after each delay in `POST_RETRY_DELAYS_MS`, 1 s and then 4 s, so three tries in all, inside its own `timeoutMs`. For a slow release that a retry never helps, as `terraform destroy`, set `retry: "once"`.

When every try failed, the post step stays owed and the run fails. What it releases may still be there. On GitHub, the action's `post` entry tries it again at the end of the job. Then the next run of the same workflow file runs it before any task. If it fails again, no task of that run starts, and the run fails. To stop paying it after you removed what it releases by hand, remove the run's history from `.dag/history/`.

A run does not wait for another run that is paying a debt at the same time. Two runs of one workflow file that start together can thus start tasks while the other pays.

### Keep services up between runs

A post step releases everything after each run, so each run starts from nothing. That is the safe default. When you want a service to outlive a run, for example while you fix a failing end-to-end test, build another graph:

- Start the services in one workflow, with a task that runs until Ctrl-C, such as `sleep infinity`, and depends on them. Their post steps run when you stop that run.
- Run the tests in a second workflow, in another terminal, as often as you like. Each run belongs to its own workflow file, so the tests never pay or wait for the services' post steps.
- To reset state between runs, add a task to the tests workflow that does it, such as truncating the database.

## Timeouts

`timeoutMs` is the `timeout-minutes` of a GitHub step, in milliseconds. `workflow.task` and a post step take it:

```typescript
workflow.task({ name: "test", cmd: ["pnpm", "test"], inputs: src, timeoutMs: 15 * 60_000 });
```

When the time ends, dagworkflows stops the command as a cancellation does. The task fails with the runner's message: "The action 'test' has timed out after 15 minutes." Its check run shows `timed_out`.

A timeout is a failure, not a cancellation. Thus the run continues:

- dagworkflows skips the tasks that need the task.
- The tasks that need it through `settled` run.

These rules apply:

- dagworkflows does not cache a task that timed out.
- The timeout is not part of the cache key. A change to it does not run the task again.
- A post step has its own timeout.
- The limit for the full run is the `timeout-minutes` of the job in your YAML. When it ends, GitHub cancels dagworkflows.

A command can leave a process that keeps its output open, for example a server that it starts with `&`. dagworkflows waits for that process for `STREAM_DRAIN_GRACE_MS` after the command exits. Then the task finishes.

## Cancellation

dagworkflows cancels a run as GitHub cancels a job. This applies on GitHub and when you push Ctrl-C:

1. The tasks that wait finish as `cancelled`.
2. Each running command gets SIGINT, then SIGTERM, then SIGKILL. The intervals are in `src/config.ts`. They fit in the time that GitHub gives. Each command runs in a process group of its own, and the signals go to the group. When a command exits, what is left of its group, such as a job started with `&`, gets SIGTERM and then SIGKILL.
3. The running tasks finish as `cancelled`, whatever their exit code.
4. The process exits with code 130.
5. The post steps that the run owes run. Nothing else starts after a cancellation, a cache save included.

For the GitHub sequence, see [Workflow cancellation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation).

dagworkflows records each task in the run's history when it starts and when it finishes. On GitHub, the `post` entry of the action reads that history and runs the post steps that the run owes. `dag run`, in a terminal or in a `run:` step, has no `post` entry. Thus it runs these post steps itself after a cancellation.

A second Ctrl-C kills the process group of each running command and exits at once. A closed terminal (SIGHUP) cancels as Ctrl-C does. A process can also be killed outright. In each case the post steps stay owed in the run's history, and the next run of the same workflow file runs them before any task, as for [a post step that fails](#a-post-step-that-fails).

Each run writes its own history in `.dag/history/`, and holds a lock next to it while it runs ([proper-lockfile](https://github.com/moxystudio/node-proper-lockfile)). A run settles another run's history only when that lock is released, or stale after a kill (`HISTORY_LOCK_STALE_MS`, 10 s). Thus two runs in one worktree, or in a container that shares it, never settle each other's post steps.
