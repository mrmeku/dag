# Secrets

Give secrets to commands only through the environment of the action step. Never put a secret in `cmd`, `env` or `inputs`: each is part of the cache key.

```yaml
- uses: mrmeku/dagworkflows@v0
  with:
    workflow: scripts/ci.ts
  env:
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## What a command can see

A command gets the whole environment of the process that runs it, locally and on GitHub. In the action, that includes variables that a `run:` step never sees:

- the inputs of the action (`INPUT_*`),
- the runner's `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RUNTIME_URL`, `ACTIONS_CACHE_URL` and `ACTIONS_RESULTS_URL`.

With the runtime token, any command can read and write the Actions cache of the repository. Run only commands that you trust with it, as for any action.

## Masking

The runner masks each secret of the job, `GITHUB_TOKEN` and its own tokens before a step starts. It masks them in the log and in the step summary. To mask a value that a command makes, print `::add-mask::<value>`, as on GitHub. In the workflow file, call `core.setSecret(value)`.

On GitHub, dagworkflows writes command output only to the log. Locally, it also writes `.dag/logs` and `.dag/failures.md`. A check run links to the run's log. It does not hold the log.

## Where logs go

The log of each task is in `.dag/cas.logs`, next to the CAS and not in it. Thus a `workflow.saveCache` of `.dag/cas` does not upload logs.

> [!CAUTION]
> Cache `.dag/cas`, not all of `.dag`. A pull request can restore a cache entry, also a pull request from a fork.

## Limits of masking

Masking hides a secret that a command prints by accident. It does not stop a command that leaks a secret on purpose. dagworkflows never changes a declared output file, as GitHub never masks artifacts or caches.

If a secret gets into a saved CAS, do these steps:

1. Rotate the secret.
2. Delete the cache entries with `gh cache delete`.

A new cache key is not sufficient: a pull request can still restore an old entry.
