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

## dagworkflows

### [dagworkflows-workflows](dagworkflows-workflows.md)

How a workflow file is written: it default-exports `defineWorkflow({ implementation })`, and the `workflow` object adds tasks and other nodes to a dagraph graph. A task is an `action`, a `cmd` or a `shell`, cached on what it declares and never on its code.

- Concepts: type-checking a workflow file, task and command, choosing an action or a command, deps by role, inputs, outputs, when a task runs, the receipt pattern for side effects, a task's cache key, scheduler options and concurrency groups, helpers and composition, the required check, `post` fields, `--only` selection, the `@actions` toolkit, testing a workflow.
- Public names: `defineWorkflow`, `createWorkflow`, `workflow.task`, `workflow.glob`, `workflow.hash`, `workflow.compose`, `workflow.requireAll`, `workflow.ctx`, `workflow.ports`, `selectNodes`, `postNodes`, `TaskSpec`, `PostSpec`, `CiContext`, `Ports`, `DEFAULT_EXCLUDES`, `DEFAULT_CACHE_DIR`, and the test doubles (`createTestPorts`, `okExec`, `clockAt`, `steppingClock`).
- Read it when writing or changing a workflow, a task spec, selection, or the public surface of the package.

### [dagworkflows-lifecycle](dagworkflows-lifecycle.md)

The life of one run, from building the graph to its outcome. Post steps are obligations: owed once their task starts, recorded before any effect, and paid by a later run before any task if left unpaid. The page also covers services, run history and its lock, cancellation and signals, timeouts, exit codes, and the run store and its kernel.

- Concepts: main and post, owed, pass and post pass, run history, services kept up across runs, cancel, node states holding dagraph's `NodeResult` as it is and its event times (`succeeded` for a build or a hit, told apart by `details.actionRan`), start recorded (the history's, which decides what is owed) apart from action ran (dagraph's `elapsed`, on its details), a history whose results are in an older shape (only those results dropped, its debts kept), and the run's lifecycle, the run store and its listeners, the last run's durations, ports (`ExecResult.ended`) and step records (`CommandCause.ended`).
- Public names: `runWorkflow`, `runJob`, `runPost`, `RunOptions`, `RunOutcome`, `createRunHistory`, `readRunHistory`, `runHistoryLive`, `RunHistory`, `DEFAULT_HISTORY_DIR`, `DEFAULT_DURATIONS_DIR`, `RunState`, `RunLifecycle`, `RunAction`, `NodeAction`, `Pass`, `NodeState` and its cases, `selectors`, `createRunStore`, `RunStore`, `RunListener`, `FileSystem`, `createFileSystem`.
- Read it when touching post steps, cancellation, history, exit codes, the run store or the kernel's reducers and state types.

### [dagworkflows-cache-artifacts](dagworkflows-cache-artifacts.md)

The cache and artifacts as nodes of the graph. `workflow.cache` adds a restore node and returns a `save()` that adds a save node run after every other task; `workflow.uploadArtifact` uploads files, including other nodes' outputs straight from the cache dir. Both go through ports, so one workflow runs unchanged locally, on GitHub and in tests.

- Concepts: cache entry, key and restore keys, hit and miss, partial saves, artifacts, caching the cache dir between runs, local worktree restore versus GitHub.
- Public names: `workflow.cache`, `workflow.uploadArtifact`, `ActionsCacheSpec`, `SaveSpec`, `UploadArtifactSpec`, `CacheStore`, `ArtifactStore`, `createActionsCacheStore`, `createActionsArtifactStore`, `artifactServiceAvailable`, `createMemoryCacheStore`, `createMemoryArtifactStore`, `nullCacheStore`, `nullArtifactStore`.
- Read it when changing restores, saves, artifact uploads or the cache and artifact store ports.

### [dagworkflows-output](dagworkflows-output.md)

What a run shows. Every output is a listener on the run store: the terminal in the `live`, `failures` or `grouped` style, per-node log files, the failures report, GitHub's log groups and check runs; the step summary is rendered from the store's report at the end of each pass.

- Concepts: which failure is the cause (every failed node is named; a skipped one only under its causes, dagraph's `rootCauses`), built and cached (a `succeeded` result's `details.actionRan`), durations (dagraph's `elapsed`, a cache hit's lookup), the recap, log files and the build log, `failures.md`, check runs, the step summary and its renderers, warnings, secrets and masking, hosts.
- Public names: `createReporter`, `SummaryRenderer`, `RunReport`, `NodeReport`, `DEFAULT_SUMMARY_RENDERERS`, `renderStatus`, `renderTimeline`, `renderCriticalPath`, `renderDag`, `renderFailures`, `renderTable`, `formatDuration`, `failureMessage`, `Host`, `CommandCause`, `createLocalHost`, `nullHost`, `createRecordingHost`, `DEFAULT_BUILD_LOG_DIR`, `DEFAULT_SUMMARY_PATH`; `@mrmeku/dagworkflows/github` (`createGithubHost`).
- Read it when changing anything a run prints or writes for a reader, which failure counts as the cause, or a host.

### [dagworkflows-cli-action-release](dagworkflows-cli-action-release.md)

The two forms of the runner and how the repository ships them. It covers the `dag` CLI (commands, options, local and GitHub mode, exit codes, environment variables, the files a run writes), the GitHub Action and its inputs, and the dag repository's layout, CI, packing, release and docs check.

- Concepts: workflow file, local mode and GitHub mode, `dag run` step by step, `dag post`, fixed values, how the action maps to the CLI, which Node runs the action and which its tasks find, `v*` releases and dist-tags, the versions a first release can take, the npm description, issues and pull requests on the action repository.
- Public names: `dag run`, `dag post`, `--force`, `--only`, `--cache-dir`, `--output-style`, `--log-dir`, `--failures-report-file`, `--history-dir`, `--summary-file`; the action inputs `workflow`, `cache-dir`, `history-dir`, `force`, `only`.
- Read it when changing the CLI or the action, the files a run writes, or the repository's CI, packing or release.
