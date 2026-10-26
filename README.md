# dag

Two TypeScript packages built on one idea, a typed graph of cached steps: an engine, and a CI runner on top of it.

## Packages

If your program is a chain of slow or costly steps, each reading what earlier ones wrote and most producing the same thing as last time, you want [`@mrmeku/dagraph`](packages/dagraph/README.md). You define each step once as an action with typed inputs, dependencies and outputs. Then you add it to a graph as nodes, one per use. Wiring mistakes show up when you compile or add a node, never halfway through a long run. A step whose inputs have not changed is not run again.

If your CI is a YAML list of steps that runs top to bottom every time, you want [`@mrmeku/dagworkflows`](packages/dagworkflows/README.md). You write the job as a TypeScript file that builds a graph of tasks. The runner runs independent tasks in parallel and skips a task whose result is already cached. The same file runs the same way on your laptop, with the `dag` command, and on GitHub, with the dagworkflows GitHub Action.

## Develop

To work on both packages in a clone:

```sh
bun install   # install dependencies
bun run ci    # typecheck, lint, test and pack both packages
bun run docs  # regenerate the API reference and the generated tables
```

`bun run ci` runs the same graph that [CI](.github/workflows/ci.yml) runs on GitHub. A rerun skips each check whose inputs did not change.

AI coding agents working on this code: start at [semantics/README.md](semantics/README.md).

## Contributing

This repository is a read-only export of an upstream repository, so pull requests are closed automatically. Open an issue instead, for a bug, a feature request or a fix. Give a fix as a patch or a link to a branch. [CONTRIBUTING.md](CONTRIBUTING.md) has the details.

## License

MIT. See [LICENSE](LICENSE).
