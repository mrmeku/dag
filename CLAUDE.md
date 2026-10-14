- IMPORTANT: Skip sycophantic flattery; avoid hollow praise and empty validation. Probe my assumptions, surface bias, present counter-evidence, challenge emotional framing, and disagree openly when warranted; agreement must be earned through reason
- IMPORTANT: When I suggest non-idiomatic naming, patterns, or approaches, proactively point out the idiomatic alternative and explain why it's preferred. Teach me the idioms of the language/framework we're working in

General programming principles:

1. put all configuration in global variables that I can edit, or in a single config file.
2. use functions instead of objects wherever possible
3. prioritize low amounts of comments and whitespace. Only include comments if they are necessary to understand the code because it is really complicated
4. prefer simple, straightline code to complex abstractions
5. use libraries instead of reimplementing things from scratch
6. look up documentation for APIs on the web instead of trying to remember things from scratch
7. write the program, reflect on its quality, simplicity, correctness, and ease of modification, and then go back and write a second version
8. prefer idiomatic solutions — use the conventions, naming patterns, and standard approaches of the language/framework rather than inventing custom ones
9. when wrapping a library, use its types: a port is a `Pick` of the library's own interface, and a JSON file that carries a library's result holds the library's return value verbatim. Never define a parallel type for data a library already types; add fields only where the library gives none

## Project

A Bun workspace of two packages. This directory is exported as is to the public repository `mrmeku/dag`; nothing application-specific belongs in it.

- **`packages/dagraph`**: the generic DAG engine. Its index must reach no I/O modules (`node:*`, `bun`): consumers bundle it into sandboxes. Runtime adapters live under subpath exports (`@mrmeku/dagraph/fs`, `/fs/node`); `sandbox-safe.test.ts` enforces it. Tests run under `bun test`.
- **`packages/dagactions`**: a CI runner on the engine, on Node (`node --test`). `defineStep` binds `defineAction` to its `Ports`; `defineWorkflow` exposes the step vocabulary as `w`. Every GitHub Actions idiom (workflow commands, the context, cache, artifacts, globbing, inputs) comes from the actions toolkit, `@actions/*`, never from a re-implementation; only `createSh` and the journal are ours, because the toolkit has no cancellation sequence and no local post pass. The action under `action/` is a JavaScript action whose bundle `bun run build:action` builds; it is never committed.
- **`scripts/ci.ts`** is this repository's CI as a dagactions workflow, run by `bun run ci` locally and by `.github/workflows/ci.yml` through the action. `scripts/release.ts` is the release: packs, npm publishes with trusted publishing, and the action's build output pushed to `mrmeku/dagactions` by `scripts/release-action.ts`. `bun run release` dry-runs it. Findings: `plans/release-exercise.md`.

### Cache constraints

Action key = hash(nodeName + config + sorted dep content hashes + sorted input file hashes). A config change invalidates the cache: bump the config when an action's logic changes. `--force` is a one-off retry. `cacheable: false` opts a node out. Dep hashes are sorted, so reordering `deps` changes nothing. A node that re-executes to identical output does not invalidate its dependents.

### Testing

Tests exercise real logic: data transformations, parsing, merge semantics, cache invalidation, integration flows. Never write tests that only verify a mock was called, that only cover null or empty inputs, that repeat assertions another test makes, or that assert fields one at a time instead of one `deepEqual` on the full expected shape. Test doubles for dagactions are in `packages/dagactions/src/ports/memory.ts`.
