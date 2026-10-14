# dagactions

Define GitHub Actions jobs as a DAG in TypeScript. Run them locally too.

A GitHub Actions (GHA) job is a list of steps that run one after another. dagactions makes it a graph: each step says what it depends on and which files it reads, so independent steps run concurrently, within the limits you set. The engine writes each step's outputs to a content-addressed store (CAS). Carry that store between runs, with `actions/cache`, a persistent runner or any other store, and a step whose inputs have not changed is a cache hit: an edit re-runs only the steps that read it.

dagactions is [`@mrmeku/dagraph`](https://github.com/mrmeku/dag/tree/main/packages/dagraph) pointed at GHA. The engine schedules and caches file-producing jobs; dagactions supplies the steps a GHA job is made of: run a command, restore and save an `actions/cache` entry, run a post step.

## How a workflow is written

A workflow file default-exports `defineWorkflow`. Each step returns a ref; passing a ref in another step's `deps` is the edge.

```typescript
import { defineWorkflow } from "@mrmeku/dagactions";

export default defineWorkflow({
  limits: { maxParallelism: 4, concurrencyLimits: { test: 2 } },
  build: async (w) => {
    // actions/cache/restore: the lockfile's exact key first, then the newest older entry.
    const pnpm = w.restoreCache({
      name: "restore:pnpm",
      path: ["~/.local/share/pnpm/store"],
      key: `pnpm-${process.platform}-${await w.hash("pnpm-lock.yaml")}`,
      restoreKeys: [`pnpm-${process.platform}-`],
    });
    // Runs every time: a cached result would skip a real install on a fresh runner.
    const install = w.run({
      name: "install",
      cmd: ["pnpm", "install"],
      deps: { pnpm },
      cacheable: false,
    });
    // Declare what each command reads. A README edit then re-runs nothing.
    const src = await w.glob("src/**", "package.json", "tsconfig.json");
    // A record, not a sequence: nothing here depends on anything else, so all of it starts
    // at once. Ordering is declared only through `deps`. `group` must name a declared limit.
    const checks = w.runAll({
      typecheck: { cmd: ["pnpm", "typecheck"], inputs: src, deps: { install } },
      lint: { cmd: ["pnpm", "lint"], inputs: src, deps: { install } },
      test: { cmd: ["pnpm", "test"], inputs: src, deps: { install }, group: "test" },
    });
    w.gate({ deps: checks });
    // actions/cache/save, right after install, with an optional dep so it saves even when install failed.
    w.saveCache({ name: "save:pnpm", cache: pnpm, deps: { install: w.optional(install) } });
  },
});
```

`limits` are the engine's concurrency knobs: how many nodes run at once, and a cap per named group. A step's `group` must be one the limits declare, or it does not compile.

A step's outputs are the files its command writes under `$DAGACTIONS_OUT` and declares by name: `outputs: { tarball: "pkg.tgz" }`. A later step names one where it takes it, in a command argument or an `env` value, as `pack.outputs.tarball`, the `steps.pack.outputs.tarball` of a workflow file; `pack` must be in its `deps`, or the step does not build. The reference resolves to the file's path in the CAS when the command runs, and to the empty string when the output belongs to an optional dep that failed, as on GitHub.

## How it runs

On GitHub:

```yaml
- uses: mrmeku/dagactions@v1
  with:
    workflow: scripts/ci.ts
  env:
    GITHUB_TOKEN: ${{ github.token }} # optional: one check run per node
```

Locally:

```
npx dagactions run scripts/ci.ts [--force] [--only a,b] [--cas .dagactions/cas]
```

`--only` runs the named nodes and their transitive dependencies, nothing else. `--force` ignores the CAS.

## The toolkit underneath

dagactions is the [actions toolkit](https://github.com/actions/toolkit) arranged as a graph, not a re-implementation of it. On GitHub, `@actions/core` writes the log groups, annotations and step summary, `@actions/github` supplies the context and the check runs, `@actions/cache` and `@actions/artifact` are the cache and artifact services, and `w.glob` and `w.hash` are `@actions/glob`: a pattern matches what the `path:` of `actions/cache` or `actions/upload-artifact` and the `hashFiles()` expression would match, hidden files included, and `w.hash` is `hashFiles()` byte for byte. The directories in `DEFAULT_EXCLUDES` (`config.ts`) are negated on every call. A negation filters but does not prune, so root a pattern below `node_modules`: `src/**` walks `src`, while `**` walks the whole tree, thirty seconds with a `node_modules` present. Each port is a `Pick` of the toolkit's own interface and each node's JSON output is what the toolkit returned.

## actions/cache as DAG nodes

`w.restoreCache` is `actions/cache/restore` and `w.saveCache` is `actions/cache/save`, with the actions' inputs (`path`, `key`, `restoreKeys`). Each node's output file holds what `@actions/cache` returned, as JSON: `cache.json` the key restored or null, `save.json` the entry's id, -1 when nothing was saved, or null when no save was attempted. Match order, immutability, branch scope and quotas are GitHub's; see the [dependency caching reference](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching). Both nodes run every time. The save is a post step with the usual `if: cache-hit != 'true'` built in, and a save the service refuses is a warning, not a failure. Without a cache service, locally or in a `run:` step, every restore misses and every save is a no-op.

## actions/upload-artifact as a DAG node

`w.uploadArtifact` is `actions/upload-artifact`, with the action's inputs (`artifact` for its `name`, `path`, `ifNoFilesFound`, `overwrite`) and `@actions/artifact`'s own `UploadArtifactOptions` as `options`. `artifact.json` holds the client's `UploadArtifactResponse` as returned: `id`, `size` and `digest`, or `{}` when nothing went up. `path` takes globs over the working tree and the outputs of deps, so a build product goes up straight from the CAS:

```typescript
const pack = w.run({
  name: "pack",
  cmd: ["npm", "pack", "--pack-destination", "$DAGACTIONS_OUT"],
  outputs: { tarball: "pkg-1.0.0.tgz" },
  deps: { install },
});
w.uploadArtifact({
  name: "upload:tarball",
  artifact: "tarball",
  path: [pack.outputs.tarball],
  deps: { pack },
});
w.uploadArtifact({
  name: "upload:junit",
  artifact: "junit",
  path: ["reports/**/*.xml"],
  deps: { tests: w.optional(tests) },
  ifNoFilesFound: "ignore",
});
```

An artifact belongs to the run, so the node runs every time and is never cached; its `deps` say when, and `w.optional` is the `if: always()` of a test report. The archive is rooted at the deepest directory holding every file, as the action roots it: one node's outputs sit at the top, outputs of several nodes keep their CAS paths. An upload the service refuses fails the node, as the action fails its step; a name the run already holds is refused unless `overwrite` is set, which matters when a failed job is re-run. Without a service, locally or in a `run:` step, nothing is uploaded and the log says so. Artifacts need no permission beyond the runner's own token. Retention, size and storage quotas are GitHub's; see [storing and sharing data from a workflow](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/storing-and-sharing-data-from-a-workflow).

## How post cleanup steps work

A GitHub action has a `main` and a `post`, which runs at the end of the job whatever happened in between. `w.post` is that, for any node:

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

A post step runs every time and is never cached. A graph has no end of job, so `deps` says what the post waits for: `w.optional(tests)` is `if: always()`, and `deps: {}` is right after `main`. A failed `main` has no post.

## How cancellation works

GitHub cancels a job with SIGINT to the step, SIGTERM 7500 ms later and a tree kill 2500 ms after that, then runs every action's `post` in its own process; see [workflow cancellation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation). dagactions does the same, on GitHub and under Ctrl-C. Nodes still waiting settle as `cancelled`, running commands get SIGINT, SIGTERM and SIGKILL in turn (grace periods in `config.ts`, sized to fit inside GitHub's window), and the process exits with 130 once they have stopped. The run journals every node as it settles, so the action's `post` entry can then run the post steps the run did not reach. Locally, `dagactions run` does that itself after Ctrl-C.

## How it reports

The reporter turns the engine's event stream into GHA output: a line when a node's action starts, with its duration in the last run, and none for a cached node; one collapsible group per node that ran, emitted when the node settles so concurrent output never interleaves, with the command's stdout and stderr in the order it wrote them; one plain line per node that was skipped or cancelled; an annotation per failure; a step summary, headed `## dagactions · <workflow file>`; and one check run per node in the PR Checks tab, live. Check runs need `checks: write` and `GITHUB_TOKEN` in the step env, and are silently off without them.

The log ends with a recap outside any group, so it is what a failed step shows last:

```
dagactions · scripts/ci.ts · ✖ test:unit failed · built 1 · cached 4 · failed 2 · skipped 1 · wall 9.8s
failed: test:unit, gate
skipped, dependency failed: deploy
reproduce: npx dagactions run scripts/ci.ts --only test:unit
```

A failure's cause is a failed node with no failed dependency: `gate` above failed because `test:unit` did, so the headline and the reproduce line name `test:unit` alone.

### Choosing what the summary shows

The step summary is drawn by a list of renderers, top to bottom, under a `## dagactions` heading. A renderer is a function: the reporter calls it with the run's data, a `RunReport`, and it returns markdown lines; `[]` draws nothing. The report holds every node with its status, timing, previous duration, error and outputs, and `log(name)` reads a node's log back from the CAS.

| renderer             | draws                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `renderStatus`       | the outcome as a headline, then counts, wall time, parallelism, cache hits and the time they saved            |
| `renderTimeline`     | a gantt of the nodes that ran: what happened when, and what overlapped                                        |
| `renderCriticalPath` | the longest chain by duration, of nodes that took `CRITICAL_PATH_FLOOR_MS` (1s) or more; hidden when none did |
| `renderDag`          | the DAG colored by status                                                                                     |
| `renderFailures`     | each failed node's log tail, and a line per skipped or cancelled node, causes first                           |
| `renderTable`        | node, status, duration and the change against the previous run                                                |

`DEFAULT_SUMMARY_RENDERERS` is all of them but the table. A workflow sets its own list with `summary`, mixing these with renderers of its own; one of yours can call a built-in, on a filtered report if it likes.

```typescript
import {
  defineWorkflow,
  formatDuration,
  renderDag,
  renderFailures,
  renderTimeline,
  type RunReport,
} from "@mrmeku/dagactions";

// What the table showed that nothing else does: the nodes slower than last run.
const renderSlower = (r: RunReport) => {
  const rows = r.nodes.flatMap((n) =>
    n.status === "done" && n.duration !== undefined && n.previous && n.duration > n.previous * 1.2
      ? `- ${n.name}: ${formatDuration(n.previous)} → ${formatDuration(n.duration)}`
      : [],
  );
  return rows.length > 0 ? ["### slower than last run", "", ...rows] : [];
};

// A built-in, wrapped: the DAG without the cache plumbing, folded.
const renderFoldedDag = (r: RunReport) => [
  "<details><summary>DAG</summary>",
  "",
  ...renderDag({ ...r, nodes: r.nodes.filter((n) => !/^(restore|save):/.test(n.name)) }),
  "",
  "</details>",
];

export default defineWorkflow({
  summary: [renderTimeline, renderFoldedDag, renderSlower, renderFailures],
  build: async (w) => {
    // ...
  },
});
```

`[...DEFAULT_SUMMARY_RENDERERS, renderTable]` is the default with the table back at the bottom, and `summary: []` leaves the summary empty. A renderer that throws leaves a note in its place and a warning annotation, and never changes the run's outcome. The post pass draws the post steps it ran with the same list. Past `SUMMARY_BUDGET_BYTES` (900,000 UTF-8 bytes, under GitHub's 1 MiB cap), the log blocks (` ```text ` fences) are dropped first, then each block that no longer fits, so the renderers listed first keep their room.
