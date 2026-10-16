# Lifecycle

dagactions starts, stops and cleans up steps as GitHub does:

- A **post step** runs after its main step, also when other steps fail.
- A **timeout** fails one step and lets the run continue.
- A **cancellation** stops all steps, and then runs the post steps.

## Post steps

A GitHub action has a `main` and a `post`. The `post` runs at the end of the job, also when the job fails. `w.post` gives a post step to any step:

```typescript
const db = w.run({
  name: "up:db",
  cmd: ["sh", "-c", "docker run -d postgres:16 > $DAGACTIONS_OUT/id"],
  outputs: { id: "id" },
  cacheable: false,
});
const tests = w.run({ name: "test", cmd: ["pnpm", "test"], deps: { db, install } });
w.post({
  name: "down:db",
  main: db,
  env: { DB_ID: db.outputs.id },
  cmd: ["sh", "-c", "docker rm -f $(cat $DB_ID)"],
  deps: { tests: w.optional(tests) },
});
```

A graph has no end of job. Thus `deps` tells when the post step runs:

- `deps: { tests: w.optional(tests) }` runs it after the tests, also when they fail. This is `if: always()`.
- `deps: {}` runs it immediately after `main`.

These rules apply:

- A post step runs each time. dagactions never caches it.
- If `main` fails, its post step does not run.
- If a cancellation stops a post step, the post step runs again later. Thus its command must be safe to run twice, as `docker rm -f` is.

## Timeouts

`timeoutMinutes` is the `timeout-minutes` of a GitHub step. Use it on `w.run`, `w.runAll` and `w.post`:

```typescript
w.run({ name: "test", cmd: ["pnpm", "test"], inputs: src, timeoutMinutes: 15 });
```

When the time ends, dagactions stops the command as a cancellation does. The step fails with the runner's message: "The action 'test' has timed out after 15 minutes." Its check run shows `timed_out`.

A timeout is a failure, not a cancellation. Thus the run continues:

- dagactions skips the steps that need the step.
- The steps that need it through `w.optional` run.

These rules apply:

- dagactions does not cache a step that timed out.
- The timeout is not part of the cache key. A change to it does not run the step again.
- A post step has its own timeout.
- The limit for the full run is the `timeout-minutes` of the job in your YAML. When it ends, GitHub cancels dagactions.

A command can leave a process that keeps its output open, for example a server that it starts with `&`. dagactions waits for that process for `STREAM_DRAIN_GRACE_MS` after the command exits. Then the step finishes.

## Cancellation

dagactions cancels a run as GitHub cancels a job. This applies on GitHub and when you push Ctrl-C:

1. The steps that wait finish as `cancelled`.
2. Each running command gets SIGINT, then SIGTERM, then SIGKILL. The intervals are in `src/config.ts`. They fit in the time that GitHub gives.
3. The running steps finish as `cancelled`, whatever their exit code.
4. The process exits with code 130.
5. The post steps that did not finish run.

For the GitHub sequence, see [Workflow cancellation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation).

dagactions records each step in a journal when it finishes. On GitHub, the `post` entry of the action reads the journal. It runs the post steps that the run did not reach, and the post steps that the cancellation stopped. `dagactions run`, in a terminal or in a `run:` step, has no `post` entry. Thus it runs these post steps itself after a cancellation.
