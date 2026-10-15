# dag

Two packages for running work as a directed acyclic graph, with content-addressed caching.

| package                                     | what it is                                                                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@mrmeku/dagraph`](packages/dagraph)       | The engine: a graph of file-producing actions, executed in parallel, cached by the hash of each action's config, inputs and dependency outputs.           |
| [`@mrmeku/dagactions`](packages/dagactions) | A CI runner on the engine: write a job as a graph of steps, run it on GitHub Actions or on your laptop from the same file, with `actions/cache` as nodes. |

The GitHub action is published to [`mrmeku/dagactions`](https://github.com/mrmeku/dagactions):

```yaml
- uses: mrmeku/dagactions@v1
  with:
    workflow: scripts/ci.ts
```

This repository is an export. Its source is maintained elsewhere and copied here, one commit per
release or push, so pull requests here are closed on arrival; see [CONTRIBUTING.md](CONTRIBUTING.md).
Issues are welcome.

## Developing

Bun 1.4 and Node 24.2 or later.

```
bun install
bun run ci          # the checks, as a dagactions workflow, locally
bun run release     # the release, as a dry run
```

`bun run ci` is the same file `.github/workflows/ci.yml` runs through the action.
