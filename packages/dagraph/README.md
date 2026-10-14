# dagraph

Directed Acyclic Action Graph — _da graph._

Jobs depend on other jobs. You wire them into a graph, and the engine runs everything — parallel, cached, no wasted effort. If a job already produced the right output, it gets skipped. The engine checks the files, verifies they haven't changed, and moves on.

## What it does

dagraph is a scheduler for file-producing work. Every job takes file paths in and writes file paths out. The engine doesn't care what's in them — images, transcripts, whatever. If the work produces files, it fits.

You describe your work as a directed acyclic graph. Edges encode "this job needs that job's output." The engine figures out what can run in parallel, what needs to wait, and what can be skipped entirely because the answer is already on disk.

## How it schedules

The scheduler is a readiness-loop state machine. It starts by identifying all jobs with no dependencies — these are immediately eligible to run. As each job finishes, the scheduler checks whether any of its dependents now have all their inputs satisfied. Newly-ready jobs get priority: they jump to the front of the queue rather than waiting behind unrelated work from other branches of the graph. This keeps the working set tight. A fetch finishes, and its dependent transform starts immediately instead of sitting behind queued fetches from other subgraphs.

The engine dispatches up to a configurable number of concurrent jobs. When all slots are full, it waits for something to finish before starting anything new. When a job fails, everything downstream is marked as a dependency failure and skipped — no wasted compute on doomed work.

## How it caches

Caching is content-addressed. Each job's cache key is a hash of its name, its configuration, the content hashes of everything it depends on, and the content hashes of any input files it declares. This forms a Merkle tree: changes ripple downstream automatically. If you change a job's input, its cache key changes, and so do the keys of everything that depends on it.

Configuration is part of the cache key. If you change an ffmpeg filter, a prompt template, or any parameter that affects output quality, you need to reflect that in the configuration string. Otherwise the engine will keep serving stale cached results. This is deliberate — it makes policy changes explicit rather than silent.

Three cache backends ship with the library: in-memory (gone when the process exits), filesystem-backed (survives between runs), and tiered (checks a local cache first, falls back to a remote one, and promotes remote hits to local on read). You can implement your own — the interface is just get and put.

## How actions are defined

An action is a reusable template for a kind of work. You define it once with a naming rule, a configuration version, and an implementation function. The implementation receives whatever external dependencies it needs (HTTP clients, CLI tools, database connections) through a context object bound at definition time. The serializable parameters — IDs, paths, prompts, dependency references — stay separate. This split matters for remote execution: parameters can be shipped to a worker that has its own context.

Dependencies between actions are type-safe. When you declare that a resize action depends on a fetch action's output, the type system enforces that the resize action receives the right kind of input. Miswired dependencies are caught at compile time, not at runtime.

## How it validates

The graph validates eagerly. Adding a job with a duplicate name throws immediately. Referencing a dependency that doesn't exist throws immediately. Cycle detection runs during analysis using depth-first traversal — if the graph has a cycle, you find out before any work starts.

## How execution is dispatched

Execution goes through a pluggable runner. The default runner calls the action function directly in the current process. Swap in your own to dispatch work to remote workers, container orchestrators, or anything else. The runner receives the node, its resolved inputs, and an output directory; how it executes is its business.

Every state transition during execution — job started, succeeded, failed, hit cache, skipped due to dependency failure — is reported to an observer callback. This is how you build progress bars, logging, or monitoring without coupling any of that into the engine itself.

## Optional dependencies

Wrap a ref in `optional()` when the consumer can run without it, and declare the slot as `OptionalRef<T>`:

```typescript
interface EntryParams {
  kind: "entry";
  deps: { captions: OptionalRef<string> };
}
entry.addNode(graph, ctx, { kind: "entry", deps: { captions: optional(captionsRef) } });
```

If `captions` fails, `entry` still runs with `inputs.captions` undefined. Failures aren't cached and the missing dep is part of `entry`'s cache key, so a later execution retries `captions`, and once it succeeds `entry` re-runs with it. A plain `NodeRef` can't fill an `OptionalRef` slot, and an optional ref can't fill a required one.

## Input normalization

A node's cache key uses the full content hash of each dependency. When a node reads only part of a dependency's output, declare a fingerprint for that dep with `normalize`. The fingerprint is hashed into the key in place of the content hash, so the node stays cached while the part it reads is unchanged:

```typescript
const summarize = defineAction<Ctx, SummarizeParams, string>({
  config: "summarize-v1",
  normalize: (ctx) => ({ fetch: async (out) => (await ctx.readJson(out.meta)).description }),
  action: (ctx) => async (_params, inputs, outputDir) =>
    summarizeDescription(ctx, inputs.fetch.meta, outputDir),
});
```

A fingerprint that captures exactly what the action reads is as sound as the content hash. One that deliberately leaves something out (an audio transcript keyed on the video's identity and duration, not its encoding) is a trade-off the action makes explicitly, at the edge, rather than something applied after the fact.

## Re-running and inspecting

`execute` takes two per-run switches, each either a boolean or a predicate over nodes:

- `force` re-runs the selected nodes even when they are cached. Their dependents re-run only if the output actually changed.
- `cacheOnly` runs none of the selected nodes: one without a verified cache entry fails with `NOT_CACHED` and its dependents dep-fail. With a predicate that exempts cheap "check" nodes, this reports the cache's state and validates cached results without doing any real work.

## Timeouts and cancellation

An action receives an `AbortSignal` in its context. It fires when the execution's `signal` is aborted, or when the node's `timeoutMs` elapses, counted from the action's start:

```typescript
const transcribe = defineAction<Ctx, TranscribeParams, string>({
  config: "whisper-v1",
  timeoutMs: 15 * 60_000,
  action:
    (ctx) =>
    async (_params, inputs, outputDir, { signal } = {}) =>
      ctx.whisper.transcribe(inputs.download.audio, outputDir, { signal }),
});
```

Once the signal has fired, what the action returns no longer decides, as on GitHub's runner: a process that traps the interrupt and exits 0 has still not finished its work. A node the execution's signal interrupts settles as `cancelled`; one whose own timeout fired fails with an error named `TimeoutError`; if both fired, the cancel decides. Neither is cached. Nodes still waiting when the execution is cancelled settle as `cancelled` without starting. The engine never abandons a running action, so an action that ignores its signal still holds its slot until it returns. The timeout is not in the action key, and a whole-execution deadline is `execute(graph, ctx, { signal: AbortSignal.timeout(ms) })`.

## What belongs in the engine

The engine stays small by a single test: if a node could do it, add a node. A node has a name, a config, dependencies, an action and outputs. Anything you can express with those does not need a new concept in the engine, however natural it would be to give it one.

Checks are the standing example. A node that depends on another node, reads its outputs and writes a list of defects is a check. It is cached by its subject's content, so it runs once per version of the subject. It has its own config, so a new defect class re-runs probes over cached files rather than re-running the subject. Nothing depends on it. The engine does not know it is a check, and does not need to: a caller that wants a report runs the graph with `cacheOnly` on every node but the checks and reads their files. Giving the engine a `check` role would let it know the same thing at the cost of a field on nodes, a verdict format, and a result shape, all of which the node already expresses.

A new primitive is justified only when a node cannot express the behaviour without breaking the engine's one contract: a node's cache key covers everything that determines its output. `optional()` changes what the scheduler does when a dependency fails. `cacheable: false` changes what the cache does. `force` and `cacheOnly` are per-run decisions a node cannot make about itself. `inputs` covers files outside the graph, which a node could read but could not key on. `normalize` lets a node key on part of a dependency; a projection node that copied that part into its own output would do the same for exact fingerprints, and `normalize` exists because the lossy case cannot be written as a node honestly. Each of these is a statement about the key or the executor. None of them is something a node could have been.

When in doubt, build it as a node first. If it works, it was never a primitive.

## What it produces

Each job produces one of three outcomes: it ran and succeeded (with outputs and a content hash), it was served from cache (same shape, different status), or it failed (with an error, either its own or inherited from an upstream failure). These results are available per-job after execution completes.

## Modules

| File               | Purpose                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `types.ts`         | Core interfaces: `Node`, `Cache`, `CacheEntry`, `NodeRef<T>`, `ExecResult`, `Outputs`       |
| `graph.ts`         | `Graph` class: node registration, analysis, kind topology                                   |
| `execute.ts`       | `execute` function: standalone execution with `ExecutionContext` (cache, fs, CAS directory) |
| `exec-state.ts`    | Scheduler state machine: ready queue, inflight tracking, dependency fan-out                 |
| `define-action.ts` | `defineAction` factory: binds context, params, and config into a reusable action definition |
| `cache.ts`         | `MemCache`, `FsCache` (filesystem-backed), `TieredCache` (local + remote with promotion)    |
| `helpers.ts`       | SHA256 hashing, output verification, cycle detection                                        |

## Nodes

Every job in da graph is a node:

```typescript
interface Node {
  name: string;
  kind: string;
  deps: string[];
  config: string;
  params: BaseParams;
  action: (rawInputs: Record<string, Outputs>, outputDir: string) => Promise<Outputs>;
}
```

`params` holds everything serializable — IDs, paths, prompts, dep refs. External dependencies (filesystem, HTTP clients, CLI tools) get bound at definition time via a context object and stay outside `params`. This means `params` can be shipped to a remote worker — the worker just needs the action registry and its own context.

`kind` groups nodes by type (`"fetch"`, `"transform"`) for aggregate counts and progress displays. Not part of the cache key.

`config` is a version tag plus any parameters that should invalidate cache when changed (e.g., `"v1"` or `"v2,model=gpt4"`). Included in the action key hash.

## Defining Actions

`defineAction` separates naming, cache config, and execution into one spec:

```typescript
const resize = defineAction<Ctx, ResizeParams, string>({
  name: (p) => `resize:${p.imageId}`,
  config: "v1",
  action: (ctx) => async (params, inputs, outputDir) => {
    const outPath = `${outputDir}/resized.jpg`;
    await ctx.imageLib.resize(inputs.source, outPath);
    return outPath;
  },
});
```

First type parameter (`Ctx`) is the context type — whatever external dependencies your actions need. The `config` field can be a string or an object (objects get JSON-stringified). Change the config, the cache is dead for that action.

## Full Example

```typescript
import { defineAction, execute, Graph, MemCache, type NodeRef } from "@mrmeku/dagraph";

interface FetchParams {
  kind: "fetch";
  url: string;
}

const fetchDataset = defineAction<{}, FetchParams, string>({
  name: (p) => `fetch:${p.url}`,
  config: "v1",
  action: () => async (params, _inputs, outputDir) => {
    const outPath = `${outputDir}/dataset.json`;
    const response = await (await globalThis.fetch(params.url)).text();
    await Bun.write(outPath, response);
    return outPath;
  },
});

interface EnrichParams {
  kind: "enrich";
  endpoint: string;
  deps: { dataset: NodeRef<string> };
}

const enrichRecords = defineAction<{}, EnrichParams, string>({
  name: (p) => `enrich:${p.endpoint}`,
  config: "v1",
  action: () => async (params, inputs, outputDir) => {
    const outPath = `${outputDir}/enriched.json`;
    const records = JSON.parse(await Bun.file(inputs.dataset).text());
    const enriched = await (
      await globalThis.fetch(params.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(records),
      })
    ).text();
    await Bun.write(outPath, enriched);
    return outPath;
  },
});

interface ReportParams {
  kind: "report";
  deps: { enriched: NodeRef<string> };
}

const buildReport = defineAction<{}, ReportParams, string>({
  name: () => `report`,
  config: "v1",
  action: () => async (_params, inputs, outputDir) => {
    const outPath = `${outputDir}/report.json`;
    const enriched = JSON.parse(await Bun.file(inputs.enriched).text());
    const report = { count: enriched.length, generatedAt: new Date().toISOString() };
    await Bun.write(outPath, JSON.stringify(report));
    return outPath;
  },
});

// Build da graph
const graph = new Graph();

const datasetRef = fetchDataset.addNode(
  graph,
  {},
  {
    kind: "fetch",
    url: "https://api.example.com/records",
  },
);
const enrichedRef = enrichRecords.addNode(
  graph,
  {},
  {
    kind: "enrich",
    endpoint: "https://api.example.com/enrich",
    deps: { dataset: datasetRef },
  },
);
buildReport.addNode(
  graph,
  {},
  {
    kind: "report",
    deps: { enriched: enrichedRef },
  },
);

// Send 'em in
const results = await execute(graph, {
  cache: new MemCache(),
  fs: dagFs,
  casBaseDir: "/tmp/dagraph-cache",
});
```
