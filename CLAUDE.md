## Project

A Bun workspace of two packages. This directory is exported as is to the public repository `mrmeku/dag`; nothing application-specific belongs in it.

- **`packages/dagraph`**: the generic DAG engine. Its index must reach no I/O modules (`node:*`, `bun`): consumers bundle it into sandboxes. Runtime adapters live under subpath exports (`@mrmeku/dagraph/fs`, `/fs/node`); lint enforces it (`eslint.config.ts`). Tests run under `bun test`.
- **`packages/dagactions`**: a CI runner on the engine, on Node (`node --test`). `defineStep` binds `defineAction` to its `Ports`; `defineWorkflow` exposes the step vocabulary as `w`. Every GitHub Actions idiom (workflow commands, the context, cache, artifacts, globbing, inputs) comes from the actions toolkit, `@actions/*`, never from a re-implementation; only `createSh`, the run's history and the CLI's local output are ours, because the toolkit has no cancellation sequence, no local post pass and no terminal. Every output reads one run store, `src/kernel/` (its conventions in `src/kernel/CLAUDE.md`; its IO is the CAS's logs and last-run.json; what a step leaves it, the log's place and a failed command's `CommandCause`, comes from the leaf `src/step-records.ts`), as a `RunListener`: the GitHub renderer in `src/github/`, and the CLI's terminal renderers in `src/local/terminal/` and its log and report recorders in `src/local/recorders/`, which the action never reaches (`bundle-safe.test.ts`). A node's output comes from the engine (the action context's `output`, the `output` event), and a failed command's exit status with its error's `cause`. The action under `action/` is a JavaScript action whose bundle `bun run build:action` builds; it is never committed.
- **`scripts/ci.ts`** is this repository's CI as a dagactions workflow, run by `bun run ci` locally and by `.github/workflows/ci.yml` through the action. `scripts/release.ts` is the release: packs, npm publishes with trusted publishing, and the action's build output pushed to `mrmeku/dagactions` by `scripts/release-action.ts`. `bun run release` dry-runs it. Findings: `plans/release-exercise.md`.

### Cache constraints

Action key = hash(nodeName + config + sorted dep content hashes + sorted input file hashes). A config change invalidates the cache: bump the config when an action's logic changes. `--force` is a one-off retry. `cacheable: false` opts a node out. Dep hashes are sorted, so reordering `deps` changes nothing. A node that re-executes to identical output does not invalidate its dependents.

### Testing

Tests exercise real logic: data transformations, parsing, merge semantics, cache invalidation, integration flows. Never write tests that only verify a mock was called, that only cover null or empty inputs, that repeat assertions another test makes, or that assert fields one at a time instead of one `deepEqual` on the full expected shape. Test doubles for dagactions are in `packages/dagactions/src/ports/memory.ts`; like `node:fs`, its `SyncFs` refuses a file whose directory was never made. The CLI's `run` picks GitHub or a local session and hands its options to `runJob` (`src/runner.ts`), which the session and runner tests drive on memory ports, with an `EventEmitter` for the process. The CLI's picks of style and of GitHub, its flags and exit codes, and its Ctrl-C handling are tested by running it (`src/cli.test.ts`); a test that waits on a run takes a `timeout`, so a regression fails it instead of hanging the suite.

### Writing

READMEs, docs, commit messages and PR bodies use the Minto pyramid for structure and ASD-STE100 (Simplified Technical English) for sentences:

- **Answer first.** Each document, section and PR opens with its main point, then the grouped points that support it, then the detail.
- **Short, plain sentences.** At most 20 words in a procedure and 25 in a description. Active voice; numbered steps, one action each; one term for one concept in a whole document.
- **Tables for reference, callouts for warnings.** Options, fields and comparisons go in tables; warnings go in `> [!IMPORTANT]` blocks.
- **READMEs pitch, `docs/` explains.** Each package README links its docs with absolute GitHub URLs, because npm ships only the README. dagraph's README keeps a light mob-boss voice, with no crime themes in examples; every `docs/` page is plain.
- **Generate what code already says.** `docs/reference.md` tables come from the source through `scripts/reference-doc.ts` (`bun run docs`), and a test fails while they are stale.
- **Verify every claim** against the code, and run each example before you write it down.
