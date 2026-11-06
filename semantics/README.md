# Semantics

This directory is the semantics tier of `@mrmeku/dagraph` and `@mrmeku/dagworkflows`: one verified, plain-prose document per code domain, written for agents, from which the human docs are distilled. A change to what a domain does updates that domain's document in the same change.

## dagraph

### [dagraph-graphs](dagraph-graphs.md)

How a graph is declared, and how its action keys are computed: the `graph/` component (port: `HashFile`) and `mermaid/`. An action is a kind of work defined once with typed inputs, deps and outputs; a node is one use of it, added with `addNode`, which returns a typed ref. Graphs are acyclic by construction, and wiring mistakes are caught at compile time or when the node is added. A node's action key hashes its kind, its inputs and its deps' output hashes by role. The page also covers the package itself: entry points, runtimes, compiler settings, its component directories, their import edges and what lint enforces.

- Concepts: action, kind, node, role, dep, ref, ports, meta, settled and optional (`maybe`) roles, roles that pick some outputs (`pick`), node inputs and the action's own inputs, output refs, file handles, values that are never part of a string, subgraphs, closure, the action key and exactly what joins it, components, ports named with their owner, import edges, the module bans, the sandbox's reach and the global bans.
- Public names: `defineAction`, `actionsFor`, `Graph` (`subgraph`, `describe`), `closure`, `dep`, `settled`, `maybe`, `pick`, `nodeInputs`, `file`, `nodeRefNamed`, `requiredDeps`, `namedOutput`, `isFileHandle`, `notAString`, `Action`, `ActionSpec`, `ActionContext`, `NodeRef`, `OutputRef`, `AnyNodeRef`, `AnyOutputRef`, `Resolved`, `NodeParams`, `Outputs`; `@mrmeku/dagraph/mermaid` (`mermaidBody`, `mermaidQuote`, `MermaidOptions`); internal to graph: `computeActionKey`, `HashFile`.
- Read it when defining actions, wiring nodes, changing what `addNode` checks, the type-level guarantees or the key, drawing a graph, or moving code between components.

### [dagraph-execution](dagraph-execution.md)

How a graph is walked: the `orchestration/` (ports: `RunNode`, `Scheduler`, `Clock`, `OrchestrationListener`), `schedulers/`, `lookup-or-run/` (ports: the cache's `FileSystem`, orchestration's `Clock`, `StartTimer`, `ActionListener`) and `json/` components, and the executor `execute.ts`. Orchestration decides when a node runs and does no I/O; lookup-or-run looks one node up in the cache, or runs its action, or both; `execute` joins the two in one process. Every node ends with exactly one result, and a failure holds back only the nodes that need it.

- Concepts: settle, ready, dispatch, hit and miss, start, places and slots, schedulers and concurrency groups, the execution context and its timer (`startTimer`), testing one action, orchestration's result envelope (`succeeded`, `failed`, `cancelled`, `dep-failed`) and lookup-or-run's details (`actionRan`, `elapsed`, `timedOut`), events, timeouts, cancellation, honouring the signal, replay across dagraph versions, executors.
- Public names: `execute`, `ExecuteOptions`, `ExecutionContext`, `StartTimer`, `startGlobalTimer`, `wallClock`, `orchestrate`, `RunNode`, `lookupNode`, `runAction`, `lookupOrRunNode`, `runNode`, `Lookup`, `Miss`, `RunActionOptions`, `NodeResult`, `SucceededNodeDetails`, `HitDetails`, `FailedNodeDetails`, `CancelledNodeDetails`, `isNodeResult`, `resultActionKey`, `unboundedScheduler`, `throttledScheduler`, `Scheduler`, `Result`, `isResult`, `isSucceeded`, `countResultsByStatus`, `Clock`, `OrchestrationEvent`, `OrchestrationListener`, `ActionEvent`, `ActionListener`, `ExecutionEvent`, `ExecutionListener`.
- Read it when changing scheduling, failure propagation, events, timeouts or cancellation, or when writing an executor or a scheduler of your own.

### [dagraph-caching](dagraph-caching.md)

What makes a second run cheap: the `cache/` component (port: `FileSystem`) and the `filesystem/` adapters that fill its port. A verified entry under a node's action key (computed by graph, see dagraph-graphs) is a hit and the action does not run. Outputs live in the cache, in directories named by their content hashes, and early cutoff stops a rerun that produced the same bytes from spreading.

- Concepts: the cache and the key it is given, version inputs, keys across dagraph versions, content hash, early cutoff, output hashes and roles keyed by the outputs they read, output verification by size and mtime, read-only outputs that are regular files, the cache layout, pruning by last use, nodes that share a key, reading part of a dependency, `cacheable: false`, forcing (`forcedKeys`), what is never cached, finding out why a node reran, the cache's `FileSystem` port, the Bun and Node adapters and the in-memory double.
- Public names: `CacheEntry`, `FileSystem`, `createMemoryFileSystem`, `MemoryFileSystem`, `pruneCache`, `PruneOptions`; `ExecutionContext`'s `cacheDir` and `forcedKeys`; `@mrmeku/dagraph/fs` (`createBunFileSystem`), `@mrmeku/dagraph/fs/node` (`createNodeFileSystem`).
- Read it when a node reruns or fails to rerun unexpectedly, when changing the cache, its entries or a filesystem adapter, or when an action reads something it has not declared.
