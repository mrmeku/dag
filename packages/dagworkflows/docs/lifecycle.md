# Lifecycle

dagworkflows starts, stops and cleans up tasks as GitHub does steps:

- A **post step** runs after its main task and the tasks that use it, whatever those tasks did.
- A **timeout** fails one task and lets the run continue.
- A **cancellation** stops all tasks, and then runs the post steps.

## Post steps

A GitHub action has a `main` and a `post`. The `post` runs at the end of the job, also when the job fails. `workflow.post` adds a post step to any task, its main. A post step is a task, with an `action`, a `cmd` or a `shell`:

```typescript
const db = workflow.task({
  name: "up:db",
  cmd: ["docker", "run", "-d", "--name", "db", "postgres:16"],
});
workflow.task({ name: "test", cmd: ["pnpm", "test"], deps: { db, install } });
workflow.task({ name: "e2e", cmd: ["pnpm", "e2e"], deps: { db, install } });
workflow.post({ name: "down:db", main: settled(db), cmd: ["docker", "rm", "-f", "db"] });
```

A graph has no end of job. Thus a post step waits for its main and for each task that depends on the main, directly or through other tasks, whatever they did, and for the post steps of those tasks. `down:db` runs after `test` and `e2e`, and after a post step of `test` that reads the database. You do not list these tasks, so a new task that uses `db` is never left out.

`main` tells whether the main must succeed:

- `main: db` runs the post step only after `db` succeeded.
- `main: settled(db)` runs it after any outcome, also when `db` started and then failed. This is `if: always()`.

The `cmd`, `env` and `action` of a post step get the main's outputs as `main`, as in `cmd: ({ main }) => ["db", "stop", main.pid]`. Under `settled`, an output can be missing. Thus a command reads it through `env`, where a missing output is unset, and an `action` gets `undefined`.

Other `deps` are ordinary dependencies. `deps: { install }` runs the post step only after a successful install.

These rules apply:

- A post step that `workflow.post` adds runs each time. It takes no `inputs`, `cacheable` or `invalidateOn`, and dagworkflows never caches it. A cache save is the one post step that comes from the cache. See [Cache and artifacts](cache-and-artifacts.md#actionscache).
- No task depends on a post step. Only another post step takes it, as its `main`.
- A post step never waits for the other post steps of its main, or for theirs.
- Post steps run in the reverse order of their mains, as GitHub's do: when one main is upstream of another, as a cache restore is of `up:db`, the post steps of the downstream main run first.
- Two post steps whose mains are unrelated, and that would still wait for each other, are refused, naming both. Make one of them a task.
- If a cancellation stops a post step, the post step runs again later. Thus its command must be safe to run twice, as `docker rm -f` is.
- `--only` runs the named tasks and their dependencies, the post steps of every main among those, and the post steps' dependencies, repeated until nothing more joins. A post step waits only for the tasks of the run. Thus `--only test` stops the database after `test`, and `--only up:db` starts the database and stops it at once.

## Timeouts

`timeoutMs` is the `timeout-minutes` of a GitHub step, in milliseconds. `workflow.task` and `workflow.post` take it:

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
5. The post steps that did not finish run.

For the GitHub sequence, see [Workflow cancellation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation).

dagworkflows records each task in the run's history when it starts and when it finishes. On GitHub, the `post` entry of the action reads that history. It runs the post steps that the run owes: the post steps that did not finish, whose main ran. A main ran when it came from the cache or its work started, whatever came of it. A main that never started, because a dependency failed or the cancellation came while it waited, owes nothing. An owed post step runs when its dependencies allow it, as in a run. `dag run`, in a terminal or in a `run:` step, has no `post` entry. Thus it runs these post steps itself after a cancellation.

A second Ctrl-C kills the process group of each running command and exits at once. A closed terminal (SIGHUP) cancels as Ctrl-C does. A process can also be killed outright. In each case the post steps stay owed in the run's history, and the next run of the same workflow file runs them first. Their failures are reported, but the exit code of the next run is that of its own tasks.

Each run writes its own history in `.dag/history/`, and holds a lock next to it while it runs ([proper-lockfile](https://github.com/moxystudio/node-proper-lockfile)). A run settles another run's history only when that lock is released, or stale after a kill (`HISTORY_LOCK_STALE_MS`, 10 s). Thus two runs in one worktree, or in a container that shares it, never settle each other's post steps.
