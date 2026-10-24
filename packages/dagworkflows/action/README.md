# dagworkflows

Run a CI job as a graph of steps, with content-addressed caching, on GitHub Actions or on your
laptop from the same file.

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: 24
- uses: mrmeku/dagworkflows@v0
  with:
    workflow: scripts/ci.ts
  env:
    GITHUB_TOKEN: ${{ github.token }} # optional: one check run per node in the PR Checks tab
```

`scripts/ci.ts` is a TypeScript file that default-exports `defineWorkflow(...)` from
`@mrmeku/dagworkflows`; the action serves that package from its own bundle, so the file loads
before `npm install` has run. Locally, `npx --no dag run scripts/ci.ts` runs the same file.

| input         | default        | meaning                                                                                     |
| ------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `workflow`    |                | Path to the workflow file. Required.                                                        |
| `cas-dir`     | `.dag/cas`     | Local content-addressed cache; restore and save it with `actions/cache` nodes in the graph. |
| `history-dir` | `.dag/history` | Where each run records what settled, in a history of its own, for the post step.            |
| `force`       | `false`        | Ignore the cache for this run.                                                              |
| `only`        |                | Comma-separated nodes to run, with their dependencies and the post steps of what runs.      |

What the step summary shows, and in which order, is set in the workflow file with `summary`; see
[Select the renderers](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/docs/output.md#select-the-renderers).

The action's `post` runs at the end of the job whatever became of the main step. It runs the post
steps (service shutdowns) that the run still owes: those a cancel kept from finishing, and those
that failed every try.

This repository holds build output only. The source, documentation and issues are at
[mrmeku/dag](https://github.com/mrmeku/dag). Pin to a commit SHA if your policy requires it.
