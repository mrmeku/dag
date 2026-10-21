# Lifecycle

dagworkflows starts, stops and cleans up steps as GitHub does:

- A **post step** runs after its main step, also when other steps fail.
- A **timeout** fails one step and lets the run continue.
- A **cancellation** stops all steps, and then runs the post steps.

## Post steps

A GitHub action has a `main` and a `post`. The `post` runs at the end of the job, also when the job fails. `workflow.post` gives a post step to any step:

```typescript
const db = workflow.run({
  name: "up:db",
  cmd: ["sh", "-c", "docker run -d postgres:16 > $DAG_OUT/id"],
  outputs: { id: "id" },
  cacheable: false,
});
const tests = workflow.run({ name: "test", cmd: ["pnpm", "test"], deps: { db, install } });
workflow.post({
  name: "down:db",
  main: db,
  env: { DB_ID: db.outputs.id },
  cmd: ["sh", "-c", "docker rm -f $(cat $DB_ID)"],
  deps: { tests: workflow.settled(tests) },
});
```

A graph has no end of job. Thus `deps` tells when the post step runs:

- `deps: { tests: workflow.settled(tests) }` runs it after the tests, also when they fail. This is `if: always()`.
- `deps: {}` runs it immediately after `main`.

These rules apply:

- A post step runs each time. dagworkflows never caches it.
- If `main` fails, its post step does not run.
- If a cancellation stops a post step, the post step runs again later. Thus its command must be safe to run twice, as `docker rm -f` is.
- `--only` runs the post steps of the steps it selects. A post step waits for its deps that run. If its command names an output of a step that `--only` leaves out, the post step is left out too, with a notice.

## Timeouts

`timeoutMinutes` is the `timeout-minutes` of a GitHub step. Use it on `workflow.run`, `workflow.runAll` and `workflow.post`:

```typescript
workflow.run({ name: "test", cmd: ["pnpm", "test"], inputs: src, timeoutMinutes: 15 });
```

When the time ends, dagworkflows stops the command as a cancellation does. The step fails with the runner's message: "The action 'test' has timed out after 15 minutes." Its check run shows `timed_out`.

A timeout is a failure, not a cancellation. Thus the run continues:

- dagworkflows skips the steps that need the step.
- The steps that need it through `workflow.settled` run.

These rules apply:

- dagworkflows does not cache a step that timed out.
- The timeout is not part of the cache key. A change to it does not run the step again.
- A post step has its own timeout.
- The limit for the full run is the `timeout-minutes` of the job in your YAML. When it ends, GitHub cancels dagworkflows.

A command can leave a process that keeps its output open, for example a server that it starts with `&`. dagworkflows waits for that process for `STREAM_DRAIN_GRACE_MS` after the command exits. Then the step finishes.

## Cancellation

dagworkflows cancels a run as GitHub cancels a job. This applies on GitHub and when you push Ctrl-C:

1. The steps that wait finish as `cancelled`.
2. Each running command gets SIGINT, then SIGTERM, then SIGKILL. The intervals are in `src/config.ts`. They fit in the time that GitHub gives. Each command runs in a process group of its own, and the signals go to the group. When a command exits, what is left of its group, such as a job started with `&`, gets SIGTERM and then SIGKILL.
3. The running steps finish as `cancelled`, whatever their exit code.
4. The process exits with code 130.
5. The post steps that did not finish run.

For the GitHub sequence, see [Workflow cancellation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation).

dagworkflows records each step in the run's history when it finishes. On GitHub, the `post` entry of the action reads that history. It runs the post steps that the run did not reach, and the post steps that the cancellation stopped. `dag run`, in a terminal or in a `run:` step, has no `post` entry. Thus it runs these post steps itself after a cancellation.

A second Ctrl-C kills the process group of each running command and exits at once. A closed terminal (SIGHUP) cancels as Ctrl-C does. A process can also be killed outright. In each case the post steps stay owed in the run's history, and the next run of the same workflow file runs them first. Their failures are reported, but the exit code of the next run is that of its own steps.

Each run writes its own history in `.dag/history/`, and holds a lock next to it while it runs ([proper-lockfile](https://github.com/moxystudio/node-proper-lockfile)). A run settles another run's history only when that lock is released, or stale after a kill (`HISTORY_LOCK_STALE_MS`, 10 s). Thus two runs in one worktree, or in a container that shares it, never settle each other's post steps.
