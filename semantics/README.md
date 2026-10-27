# Semantics

This directory is the semantics tier of `@mrmeku/dagraph` and `@mrmeku/dagworkflows`: one verified, plain-prose document per code domain, written for agents, from which the human docs are distilled. A change to what a domain does updates that domain's document in the same change.

## dagraph

### [dagraph-graphs](dagraph-graphs.md)

How a graph is declared. An action is a kind of work defined once with typed inputs, deps and outputs; a node is one use of it, added with `addNode`, which returns a typed ref. Graphs are acyclic by construction, and wiring mistakes are caught at compile time or when the node is added. The page also covers the package itself: entry points, runtimes and compiler settings.

- Concepts: action, kind, node, role, dep, ref, ports, meta, settled and optional (`maybe`) roles, node inputs and the action's own inputs, output refs, file handles, values that are never part of a string, subgraphs, closure.
- Public names: `defineAction`, `actionsFor`, `Graph` (`subgraph`, `describe`), `closure`, `dep`, `settled`, `maybe`, `nodeInputs`, `file`, `nodeRefNamed`, `requiredDeps`, `soleOutput`, `namedOutput`, `isFileHandle`, `notAString`, `Action`, `ActionSpec`, `ActionContext`, `NodeRef`, `OutputRef`, `NodeParams`, `Outputs`; `@mrmeku/dagraph/mermaid` (`mermaidBody`, `mermaidQuote`).
- Read it when defining actions, wiring nodes, changing what `addNode` checks or the type-level guarantees, or drawing a graph.

### [dagraph-execution](dagraph-execution.md)

How a graph is walked. Orchestration decides when a node runs and does no I/O; processing decides what happens to one node; `execute` joins the two in one process. Every node ends with exactly one result, and a failure holds back only the nodes that need it.

- Concepts: settle, ready, dispatch, hit and miss, start, places and slots, schedulers and concurrency groups, the execution context, testing one action, result statuses (`done`, `cached`, `failed`, `dep-failed`, `cancelled`), events, timeouts, cancellation, honouring the signal, forcing, replay across dagraph versions.
- Public names: `execute`, `ExecuteOptions`, `ExecutionContext`, `orchestrate`, `RunNode`, `processNode`, `ungated`, `NOT_CACHED`, `unboundedScheduler`, `throttledScheduler`, `Scheduler`, `Result`, `isResult`, `isSucceeded`, `tally`, `ExecEvent`, `ExecListener`.
- Read it when changing scheduling, failure propagation, events, timeouts or cancellation, or when writing an executor or a scheduler of your own.

### [dagraph-caching](dagraph-caching.md)

What makes a second run cheap. A node's action key hashes its kind, its inputs and its deps' content by role; a verified entry under that key is a hit and the action does not run. Outputs live in a content-addressed store, and early cutoff stops a rerun that produced the same bytes from spreading.

- Concepts: action key and exactly what joins it, version inputs, keys across dagraph versions, content hash, early cutoff, output verification, the CAS layout, nodes that share a key, `invalidateOn` fingerprints, `cacheable: false`, what is never cached, finding out why a node reran, the `DagFs` port.
- Public names: `Cache`, `CacheEntry`, `FsCache`, `MemCache`, `DagFs`, `createMemoryDagFs`; `@mrmeku/dagraph/fs` (`createBunDagFs`), `@mrmeku/dagraph/fs/node` (`createNodeDagFs`).
- Read it when a node reruns or fails to rerun unexpectedly, when changing the key, the CAS or a cache implementation, or when an action reads something it has not declared.

## dagworkflows

### [dagworkflows-workflows](dagworkflows-workflows.md)

How a workflow file is written: it default-exports `defineWorkflow({ implementation })`, and the `workflow` object adds tasks and other nodes to a dagraph graph. A task is an `action`, a `cmd` or a `shell`, cached on what it declares and never on its code.

- Concepts: type-checking a workflow file, task and command, choosing an action or a command, deps by role, inputs, outputs, when a task runs, the receipt pattern for side effects, a task's cache key, scheduler options and concurrency groups, helpers and composition, the required check, `post` fields, `--only` selection, the `@actions` toolkit, testing a workflow.
- Public names: `defineWorkflow`, `createWorkflow`, `workflow.task`, `workflow.glob`, `workflow.hash`, `workflow.compose`, `workflow.requireAll`, `workflow.ctx`, `workflow.ports`, `selectNodes`, `postNodes`, `TaskSpec`, `PostSpec`, `CiContext`, `Ports`, `DEFAULT_EXCLUDES`, `DEFAULT_CAS_DIR`, and the test doubles (`createTestPorts`, `okExec`, `clockAt`, `steppingClock`).
- Read it when writing or changing a workflow, a task spec, selection, or the public surface of the package.

### [dagworkflows-lifecycle](dagworkflows-lifecycle.md)

The life of one run, from building the graph to its outcome. Post steps are obligations: owed once their task starts, recorded before any effect, and paid by a later run before any task if left unpaid. The page also covers services, run history and its lock, cancellation and signals, timeouts, exit codes, and the run store and its kernel.

- Concepts: main and post, owed, pass and post pass, run history, services kept up across runs, cancel, node states and the run's lifecycle, the run store and its listeners, ports and step records.
- Public names: `runWorkflow`, `runJob`, `runPost`, `RunOptions`, `RunOutcome`, `createRunHistory`, `readRunHistory`, `runHistoryLive`, `RunHistory`, `DEFAULT_HISTORY_DIR`, `RunState`, `RunLifecycle`, `RunAction`, `NodeAction`, `Pass`, `NodeState` and its cases, `selectors`, `createRunStore`, `RunStore`, `RunListener`.
- Read it when touching post steps, cancellation, history, exit codes, the run store or the kernel's reducers and state types.

### [dagworkflows-cache-artifacts](dagworkflows-cache-artifacts.md)

The cache and artifacts as nodes of the graph. `workflow.cache` adds a restore node and returns a `save()` that adds a save node run after every other task; `workflow.uploadArtifact` uploads files, including other nodes' outputs straight from the CAS. Both go through ports, so one workflow runs unchanged locally, on GitHub and in tests.

- Concepts: cache entry, key and restore keys, hit and miss, partial saves, artifacts, caching the CAS between runs, local worktree restore versus GitHub.
- Public names: `workflow.cache`, `workflow.uploadArtifact`, `ActionsCacheSpec`, `SaveSpec`, `UploadArtifactSpec`, `CacheStore`, `ArtifactStore`, `createActionsCacheStore`, `createActionsArtifactStore`, `artifactServiceAvailable`, `createMemoryCacheStore`, `createMemoryArtifactStore`, `nullCacheStore`, `nullArtifactStore`.
- Read it when changing restores, saves, artifact uploads or the cache and artifact store ports.

### [dagworkflows-output](dagworkflows-output.md)

What a run shows. Every output is a listener on the run store: the terminal in the `live`, `failures` or `grouped` style, per-node log files, the failures report, GitHub's log groups and check runs; the step summary is rendered from the store's report at the end of each pass.

- Concepts: own failure and root failure, the recap, log files and the CAS log, `failures.md`, check runs, the step summary and its renderers, warnings, secrets and masking, hosts.
- Public names: `createReporter`, `SummaryRenderer`, `RunReport`, `NodeReport`, `DEFAULT_SUMMARY_RENDERERS`, `renderStatus`, `renderTimeline`, `renderCriticalPath`, `renderDag`, `renderFailures`, `renderTable`, `formatDuration`, `Host`, `CommandCause`, `createLocalHost`, `nullHost`, `createRecordingHost`, `logPath`, `DEFAULT_SUMMARY_PATH`; `@mrmeku/dagworkflows/github` (`createGithubHost`).
- Read it when changing anything a run prints or writes for a reader, which failure counts as the cause, or a host.

### [dagworkflows-cli-action-release](dagworkflows-cli-action-release.md)

The two forms of the runner and how the repository ships them. It covers the `dag` CLI (commands, options, local and GitHub mode, exit codes, environment variables, the files a run writes), the GitHub Action and its inputs, and the dag repository's layout, CI, packing, release and docs check.

- Concepts: workflow file, local mode and GitHub mode, `dag run` step by step, `dag post`, fixed values, how the action maps to the CLI, which Node runs the action and which its tasks find, `v*` releases and dist-tags, the versions a first release can take, the npm description, issues and pull requests on the action repository.
- Public names: `dag run`, `dag post`, `--force`, `--only`, `--cas-dir`, `--output-style`, `--log-dir`, `--failures-report-file`, `--history-dir`, `--summary-file`; the action inputs `workflow`, `cas-dir`, `history-dir`, `force`, `only`.
- Read it when changing the CLI or the action, the files a run writes, or the repository's CI, packing or release.
