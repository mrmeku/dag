# The release exercise: what a CD flow asked of dagworkflows

`scripts/release.ts` is this repository's release written with dagworkflows, run by
`.github/workflows/release.yml` and locally as a dry run by `bun run release`. It was written
to test dagworkflows' semantics against a CD-shaped flow and to find what such flows still lack.

## What the flow needed, and got

| need                                                       | answer                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An artifact a later node consumes (a tarball, a bundle)    | `outputs: { tarball: "pkg-1.0.0.tgz" }` on `run`: the command writes it in its own output directory, `cmd: ({ outputDir }) => ["bun", "scripts/pack.ts", pkg, version, outputDir]`; each declared file is an output, content-addressed; a missing one fails the node.               |
| A command that takes an upstream output as an argument     | `deps: { pack }, cmd: ({ pack }) => ["npm", "publish", pack.tarball]`, the `steps.pack.outputs.tarball` of a workflow file, resolved to the file's absolute path when the command runs. The ref, not the path, is in the key, so the command stays static and the key stays honest. |
| Reuse CI's checks without a second copy                    | A workflow's implementation returns refs; `scripts/checks.ts` is a function both workflows call with their own CAS restore. Composition is a function call, not a feature.                                                                                                          |
| A side effect that a re-run must not repeat                | A receipt: `publish` says `cacheable: true`, which alone caches it, keyed on the tarball it published and its command. The CAS is saved under the release key whatever happened and restored first on a re-run, so what succeeded is skipped.                                       |
| Publish in dependency order                                | `publish:dagworkflows` depends on `publish:dagraph`. Same engine, same edges.                                                                                                                                                                                                       |
| Dry run and real run from one file                         | `workflow.ctx.ref`: a tag releases, anything else dry-runs with `--dry-run`, a different command and so a different key. Locally it is always a dry run.                                                                                                                            |
| Order after a cache restore without re-keying on its match | `invalidateOn: { cas: () => "" }`, as in CI.                                                                                                                                                                                                                                        |

## What it did not get, and should not yet

- **A directory as an output.** Outputs are files. A build that emits a tree (`dist/`) cannot
  hand the tree to the next node; `pack.ts` emits and packs in one command for that reason, and
  `build:action` bundles to one file. A tree artifact is the one engine-level addition this
  exercise would argue for, and it should wait for a second flow that needs it.
- **A node that edits the tree.** Input hashes are memoized per run, so a node that rewrites a
  file (a version bump) must not feed a node that lists it as an input. The exercise stamps the
  version on a staged copy instead and never edits the tree; that is the better flow anyway.
- **Workflow inputs.** `workflow_dispatch` inputs are not in `CiContext`. The flow derives
  everything from the ref. If a manual release with a chosen version is wanted, inputs reach
  the action as `INPUT_*` variables already; `ctx` could carry them.
- **Secrets.** They stay in the environment (`NODE_AUTH_TOKEN` on the step) and never in a
  command or an input, where they would be hashed into a key and a directory name. Nothing
  enforces that yet; a branded type on `inputs` would.
- **Approvals, environments, concurrency across runs.** GitHub owns them. A release that needs
  a human stays behind a GitHub environment in the workflow file, not a node.
- **Tooling that walks the tree.** Artifacts in the CAS are files like any other: ESLint and
  Prettier must ignore `.dag/`, or a bundle written by `build:action` fails `lint`. And a
  build whose `paths` pull a sibling package into the program emits that package's files beside
  their sources unless `rootDir` covers both; `tsconfig.build.json` is rooted at `packages/`
  for that reason. Neither is a dagworkflows concern, but both bit here.
- **The last save.** `save:cas` runs after `release`, the aggregate of the publishes and the
  action's release, so the receipts are saved even when a publish failed. Nothing orders a save
  after _every_ node; a node the save does not depend on can still be running. For a release
  that is fine: what matters is in `release`.

## What the exercise says about the engine

Every need above was met by a node, an edge, or a thin convention in dagworkflows over them. The
engine is unchanged. Of the three things dagworkflows' `run` gained (declared outputs, `$DAG_*`
variables, workflows that return refs), none is a cache primitive: they are conventions for how a
command gets at paths the engine already decides. The one candidate for the engine, a tree
artifact, stays a candidate.
