# Secrets

Give secrets to commands only through the environment of the action step. Never put a secret in `cmd` or `env`: both are part of the cache key.

```yaml
- uses: mrmeku/dagactions@v0
  with:
    workflow: scripts/ci.ts
  env:
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## What a command can see

A command gets the environment of the action step, as a `run:` step gets the environment of the job. dagactions removes the variables that a `run:` step never sees:

- the inputs of the action (`INPUT_*`),
- `GITHUB_TOKEN`,
- the runner's `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RUNTIME_URL`, `ACTIONS_CACHE_URL` and `ACTIONS_RESULTS_URL`.

## Masking

The runner masks each secret of the job, `GITHUB_TOKEN` and its own tokens before a step starts. It masks them in the log and in the step summary. To mask a value that a command makes, print `::add-mask::<value>`, as on GitHub. In the workflow file, call `core.setSecret(value)`.

On GitHub, dagactions writes command output only to the log. Locally, it also writes `.dagactions/logs` and `.dagactions/failures.md`. A check run links to the run's log. It does not hold the log.

## Where logs go

The log of each step is in `.dagactions/cas.logs`, next to the CAS and not in it. Thus a `w.saveCache` of `.dagactions/cas` does not upload logs.

> [!CAUTION]
> Cache `.dagactions/cas`, not all of `.dagactions`. A pull request can restore a cache entry, also a pull request from a fork.

## Limits of masking

Masking hides a secret that a command prints by accident. It does not stop a command that leaks a secret on purpose. dagactions never changes a declared output file, as GitHub never masks artifacts or caches.

If a secret gets into a saved CAS, do these steps:

1. Rotate the secret.
2. Delete the cache entries with `gh cache delete`.

A new cache key is not sufficient: a pull request can still restore an old entry.
