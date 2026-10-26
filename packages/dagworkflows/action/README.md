# dagworkflows

A GitHub Action that runs a dagworkflows workflow: a CI job written in TypeScript as a graph of tasks.

## Usage

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  checks: write # one check run per node

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mrmeku/dagworkflows@v1
        with:
          workflow: ci.ts
        env:
          GITHUB_TOKEN: ${{ github.token }} # optional: turns on the check runs
```

`ci.ts` is a TypeScript file that default-exports `defineWorkflow(...)` from `@mrmeku/dagworkflows`. [Install](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/README.md#install) shows how to add the package and run the same file locally. [Run on GitHub](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/github.md) covers the rest of the job, such as keeping the cache of task outputs between runs, check runs and secrets.

## Inputs

<!-- generated:action -->

| Input         | Default        | Meaning                                                                                      |
| ------------- | -------------- | -------------------------------------------------------------------------------------------- |
| `workflow`    |                | Path to the workflow file that default-exports defineWorkflow(...). Required.                |
| `cas-dir`     | `.dag/cas`     | Local content-addressed cache directory.                                                     |
| `history-dir` | `.dag/history` | Where each run records what started and settled, in a history of its own, for the post step. |
| `force`       | `false`        | Ignore the cache for this run.                                                               |
| `only`        |                | Comma-separated nodes to run, with the post steps of what runs, each with its dependencies.  |

<!-- /generated:action -->

## The post entry

A [post step](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/workflows.md#post-steps) is the teardown a task declares in its `post` field. Once the task starts, the run owes it until it succeeds.

GitHub runs the action's `post:` script by itself at the end of the job, whatever became of the main step, so the job needs no step for it. That script pays the post steps the run still owes, such as stopping a database container after a cancel.

## Versions

The major tag, such as `v1` in Usage, floats: it points at the latest release of that major.

To run in CI the version your lockfile runs locally, pin instead the commit SHA of the tag that matches your `@mrmeku/dagworkflows` version. Only a SHA never moves. `git ls-remote --tags https://github.com/mrmeku/dagworkflows v1.2.3` prints the SHA, and the step then reads `uses: mrmeku/dagworkflows@<sha> # v1.2.3`.

## Source and docs

This repository holds only what a release builds. The source, the docs and the issue tracker are in [mrmeku/dag](https://github.com/mrmeku/dag): start at the [dagworkflows README](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/README.md).

Neither repository merges pull requests. Send bug reports, requests and fixes as [issues](https://github.com/mrmeku/dag/issues).
