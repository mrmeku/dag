[**@mrmeku/dagworkflows**](../README.md)

---

[@mrmeku/dagworkflows](../README.md) / index

# index

## Namespaces

- [selectors](namespaces/selectors.md)

## Interfaces

### ActionsCacheSpec

What `workflow.cache` takes: the inputs of `actions/cache`, `path`, `key` and `restore-keys`,
and the `name` of its tasks, `restore:<name>` and `save:<name>`, `cache` unless given.

#### Properties

##### key

> **key**: `string`

##### name?

> `optional` **name?**: `string`

##### path

> **path**: `string`[]

##### restoreKeys?

> `optional` **restoreKeys?**: `string`[]

---

### ActionsCacheTasks

What `workflow.cache` returns: `actions/cache` as tasks, its restore and the adder of its save.

#### Properties

##### restore

> **restore**: [`NodeRef`](#noderef)\<`Record`\<`never`, `string`\>\>

The restore, `restore:<name>`, which runs every time. It tries `key`, then each prefix in
`restoreKeys`, and logs what it found, with which paths of `path` it restored and which were
there already. A restore that fails warns and misses, as the toolkit's does; an invalid key
fails it. It has no outputs, so a hit and a miss key its dependents alike: `deps: { cas:
cas.restore }` orders a task after it, and no task can tell a hit from a miss.

##### save

> **save**: (`saveSpec?`) => `void`

Adds the save, `save:<name>`. It waits for every other node of the run, whatever they did,
releases and other saves aside, so a node added later is never left out. It is an ordinary
node: a cancel stops it, and nothing owes it. It is never cached: the store saves only a key
it does not hold, so a second run saves nothing and an evicted entry is saved again. A save
the store refuses is a warning; an invalid key fails it. Nothing depends on it, so it returns
nothing.

###### Parameters

###### saveSpec?

[`SaveSpec`](#savespec)

###### Returns

`void`

---

### ArtifactStore

Where `workflow.uploadArtifact` puts an artifact of the run. `upload` sends `files` as the
artifact `name`, each by its path from `rootDirectory`, and resolves to the artifact's id and
size, or undefined when there is no store to take it. It rejects a name the run has used
already, unless `overwrite` replaces that artifact.

#### Extended by

- [`MemoryArtifactStore`](#memoryartifactstore)

#### Properties

##### upload

> **upload**: (`name`, `files`, `rootDirectory`, `options`) => `Promise`\<\{ `id`: `number`; `size`: `number`; \} \| `undefined`\>

###### Parameters

###### name

`string`

###### files

`string`[]

###### rootDirectory

`string`

###### options

[`ArtifactUploadOptions`](#artifactuploadoptions)

###### Returns

`Promise`\<\{ `id`: `number`; `size`: `number`; \} \| `undefined`\>

---

### ArtifactUploadOptions

What an upload takes beside its files: the inputs of `actions/upload-artifact` the service reads.

#### Extended by

- [`UploadArtifactSpec`](#uploadartifactspec)

#### Properties

##### compressionLevel?

> `optional` **compressionLevel?**: `number`

##### overwrite?

> `optional` **overwrite?**: `boolean`

Delete an artifact of the same name first: a re-run of a failed job shares its run's artifacts.

##### retentionDays?

> `optional` **retentionDays?**: `number`

---

### CacheStore

Where `workflow.cache` keeps its paths between runs. `restore` puts `paths` back from the entry
under `key`, or the newest whose key starts with `key` or a `restoreKeys` prefix, and resolves to
what it restored from, or undefined on a miss. `save` keeps `paths` under `key` unless the store
has an entry for it already, and resolves to whether it saved. A `ValidationError` rejection,
for an invalid key or path, fails the task; any other is a warning.

#### Extended by

- [`MemoryCacheStore`](#memorycachestore)

#### Properties

##### restore

> **restore**: (`paths`, `key`, `restoreKeys`) => `Promise`\<`string` \| `undefined`\>

###### Parameters

###### paths

`string`[]

###### key

`string`

###### restoreKeys

`string`[]

###### Returns

`Promise`\<`string` \| `undefined`\>

##### save

> **save**: (`paths`, `key`) => `Promise`\<`boolean`\>

###### Parameters

###### paths

`string`[]

###### key

`string`

###### Returns

`Promise`\<`boolean`\>

---

### CheckUpdate

One node's live status, as a provider "check" (GitHub: a check run in the PR Checks tab).

#### Properties

##### completedAt?

> `optional` **completedAt?**: `string`

##### conclusion?

> `optional` **conclusion?**: `CheckConclusion`

##### name

> **name**: `string`

##### startedAt?

> `optional` **startedAt?**: `string`

##### status

> **status**: `"in_progress"` \| `"completed"`

##### summary?

> `optional` **summary?**: `string`

One line of status, e.g. "done in 1.2s".

---

### Clock

#### Properties

##### now

> **now**: () => `number`

###### Returns

`number`

##### sleep

> **sleep**: (`ms`, `signal?`) => `Promise`\<`void`\>

Resolves after `ms`, or at once when `signal` aborts.

###### Parameters

###### ms

`number`

###### signal?

`AbortSignal`

###### Returns

`Promise`\<`void`\>

---

### CommandCause

What a node's error carries as its `cause` when a command it ran failed: the command, where, and how it exited.

#### Properties

##### argv

> **argv**: `string`[]

##### code

> **code**: `number`

##### cwd

> **cwd**: `string`

---

### Exec

Runs external commands, named after `@actions/exec`: an argv, with no shell unless the argv
starts one (`["sh", "-c", "..."]`). Never throws on a non-zero exit; the caller reads `code`.
`env` is merged over the inherited environment, and an `undefined` value removes a variable.
When `signal` fires the command is interrupted (SIGINT, then SIGTERM, then SIGKILL after the
grace periods in config.ts) and resolves with its exit status as usual. `onOutput` receives
`output` as it arrives, chunk by chunk. A program that cannot start resolves with code -1 and
`spawn <program> <error code>` as both `stderr` and `output`: `spawn bash ENOENT`.

#### Properties

##### run

> **run**: (`cmd`, `opts?`) => `Promise`\<[`ExecResult`](#execresult)\>

###### Parameters

###### cmd

`string`[]

###### opts?

###### cwd?

`string`

###### env?

`Record`\<`string`, `string` \| `undefined`\>

###### onOutput?

(`chunk`) => `void`

###### signal?

`AbortSignal`

###### Returns

`Promise`\<[`ExecResult`](#execresult)\>

---

### ExecResult

#### Properties

##### code

> **code**: `number`

##### ok

> **ok**: `boolean`

##### output

> **output**: `string`

Both streams as the command wrote them, in arrival order.

##### stderr

> **stderr**: `string`

##### stdout

> **stdout**: `string`

---

### Host

What a node reports through to its host, local or GitHub: annotations, log groups, check runs
and the step summary. On GitHub this emits workflow commands (collapsible log groups, plain
lines, annotations), writes the step summary, and drives check runs; locally it prints to the
terminal, writes the summary to a file, and treats checks as a no-op. Everything host-specific
goes through here, so a workflow runs unchanged in both places.

#### Properties

##### annotate

> **annotate**: (`level`, `title`, `message`) => `void`

###### Parameters

###### level

[`AnnotationLevel`](#annotationlevel)

###### title

`string`

###### message

`string`

###### Returns

`void`

##### check

> **check**: (`update`) => `Promise`\<`void`\>

###### Parameters

###### update

[`CheckUpdate`](#checkupdate)

###### Returns

`Promise`\<`void`\>

##### context

> **context**: () => `Promise`\<[`CiContext`](#cicontext)\>

###### Returns

`Promise`\<[`CiContext`](#cicontext)\>

##### group

> **group**: (`title`, `lines`) => `void`

###### Parameters

###### title

`string`

###### lines

`string`[]

###### Returns

`void`

##### info

> **info**: (`line`) => `void`

###### Parameters

###### line

`string`

###### Returns

`void`

##### summary

> **summary**: (`markdown`) => `Promise`\<`void`\>

###### Parameters

###### markdown

`string`

###### Returns

`Promise`\<`void`\>

---

### MemoryArtifactStore

Where `workflow.uploadArtifact` puts an artifact of the run. `upload` sends `files` as the
artifact `name`, each by its path from `rootDirectory`, and resolves to the artifact's id and
size, or undefined when there is no store to take it. It rejects a name the run has used
already, unless `overwrite` replaces that artifact.

#### Extends

- [`ArtifactStore`](#artifactstore)

#### Properties

##### upload

> **upload**: (`name`, `files`, `rootDirectory`, `options`) => `Promise`\<\{ `id`: `number`; `size`: `number`; \} \| `undefined`\>

###### Parameters

###### name

`string`

###### files

`string`[]

###### rootDirectory

`string`

###### options

[`ArtifactUploadOptions`](#artifactuploadoptions)

###### Returns

`Promise`\<\{ `id`: `number`; `size`: `number`; \} \| `undefined`\>

###### Inherited from

[`ArtifactStore`](#artifactstore).[`upload`](#upload)

##### uploads

> **uploads**: `Map`\<`string`, \{ `files`: `string`[]; `rootDirectory`: `string`; \}\>

Uploaded artifacts by name, in order, each with the files it holds and the root they were relative to.

---

### MemoryCacheStore

Where `workflow.cache` keeps its paths between runs. `restore` puts `paths` back from the entry
under `key`, or the newest whose key starts with `key` or a `restoreKeys` prefix, and resolves to
what it restored from, or undefined on a miss. `save` keeps `paths` under `key` unless the store
has an entry for it already, and resolves to whether it saved. A `ValidationError` rejection,
for an invalid key or path, fails the task; any other is a warning.

#### Extends

- [`CacheStore`](#cachestore)

#### Properties

##### entries

> **entries**: `Map`\<`string`, `string`[]\>

Saved keys in order, each with the paths it holds.

##### restore

> **restore**: (`paths`, `key`, `restoreKeys`) => `Promise`\<`string` \| `undefined`\>

###### Parameters

###### paths

`string`[]

###### key

`string`

###### restoreKeys

`string`[]

###### Returns

`Promise`\<`string` \| `undefined`\>

###### Inherited from

[`CacheStore`](#cachestore).[`restore`](#restore-1)

##### save

> **save**: (`paths`, `key`) => `Promise`\<`boolean`\>

###### Parameters

###### paths

`string`[]

###### key

`string`

###### Returns

`Promise`\<`boolean`\>

###### Inherited from

[`CacheStore`](#cachestore).[`save`](#save-1)

---

### NodeReport

One node as the run left it: the pass's node, plus how and when it settled.

#### Extends

- `PassNode`

#### Properties

##### cacheable?

> `optional` **cacheable?**: `boolean`

`false`: the node's entry is never read or written, so it runs in every execution.

###### Inherited from

`PassNode.cacheable`

##### concurrencyGroup?

> `optional` **concurrencyGroup?**: `string`

###### Inherited from

`PassNode.concurrencyGroup`

##### deps

> **deps**: `string`[]

The names of the nodes it depends on, once each.

###### Inherited from

`PassNode.deps`

##### duration?

> `optional` **duration?**: `number`

##### error?

> `optional` **error?**: `string`

The message of a failed or dep-failed node.

##### kind

> **kind**: `string`

###### Inherited from

`PassNode.kind`

##### meta?

> `optional` **meta?**: `unknown`

###### Inherited from

`PassNode.meta`

##### name

> **name**: `string`

###### Inherited from

`PassNode.name`

##### outputs?

> `optional` **outputs?**: `Outputs`

A done or cached node's outputs: paths into the CAS.

##### post?

> `readonly` `optional` **post?**: `true`

###### Inherited from

`PassNode.post`

##### previous?

> `optional` **previous?**: `number`

Its duration the last time it was built or failed, from last-run.json.

##### settledDeps?

> `optional` **settledDeps?**: `string`[]

The deps it runs without when they do not succeed.

###### Inherited from

`PassNode.settledDeps`

##### start?

> `optional` **start?**: `number`

Epoch ms its action started, and from then to its settle; a cache hit's is its cache check, from dispatch. Absent for a node never dispatched.

##### status

> **status**: `"done"` \| `"cached"` \| `"failed"` \| `"dep-failed"` \| `"cancelled"`

##### timeoutMs?

> `optional` **timeoutMs?**: `number`

How long the action may run, in ms, before its signal fires with a "TimeoutError".

###### Inherited from

`PassNode.timeoutMs`

---

### Pass

One pass of the runner: the run, or the post pass after a cancel. A post pass that owes
nothing is begun and never finished; GitHub still opens its banner's group.

#### Properties

##### banner?

> `optional` **banner?**: `object`

###### lines

> **lines**: `string`[]

###### title

> **title**: `string`

##### nodes

> **nodes**: `PassNode`[]

##### rerunCommand?

> `optional` **rerunCommand?**: `string`

##### title

> **title**: `string`

---

### Ports

The context every step is bound to.

#### Properties

##### artifactStore

> **artifactStore**: [`ArtifactStore`](#artifactstore)

##### cacheStore

> **cacheStore**: [`CacheStore`](#cachestore)

##### clock

> **clock**: [`Clock`](#clock)

##### env

> **env**: `Readonly`\<`NodeJS.ProcessEnv`\>

The process's environment: `process.env` in the CLI and the action. Nothing in this package
reads it; createExec merges a command's `env` over `process.env` itself.

##### exec

> **exec**: [`Exec`](#exec)

##### fs

> **fs**: `DagFs`

##### host

> **host**: [`Host`](#host)

##### lockfile

> **lockfile**: [`Lockfile`](#lockfile-1)

---

### RecordedHost

#### Properties

##### annotations

> **annotations**: `object`[]

###### level

> **level**: [`AnnotationLevel`](#annotationlevel)

###### message

> **message**: `string`

###### title

> **title**: `string`

##### checks

> **checks**: [`CheckUpdate`](#checkupdate)[]

##### host

> **host**: [`Host`](#host)

##### log

> **log**: (`string` \| \{ `lines`: `string`[]; `title`: `string`; \})[]

The job log in order: a group as its title and lines, a plain line as itself.

##### summaries

> **summaries**: `string`[]

---

### RunHistoryFile

A run's history file: its workflow file (resolved; empty when none was named) and `--only`, so
a later pass of the same workflow rebuilds the graph it ran; the nodes whose action started, in
the order they started, so a run killed mid-action still shows what it owes; and its settled
nodes' results.

#### Properties

##### only?

> `optional` **only?**: `string`[]

##### results

> **results**: [`RunHistory`](#runhistory)

##### started

> **started**: `string`[]

##### workflow

> **workflow**: `string`

---

### RunListener

What a renderer or recorder hears of the run. `begin`, `start`, `settle` and `finish` come in
the order they happened, each with the node as its action left it, a settle once its CAS log is
read, so no pass begins ahead of the last one's settles; `run` is the state as it is by then.
`isFirstPass` is the store's first pass. `immediate` hears a node start and print at once, ahead
of settles still being read, inside the engine's emit and the command's data listener; one that
throws is rethrown on the ordered hooks' chain, as if one of them had thrown, and never breaks
the emit or the stream. `close` and `interrupt` come last listener first, so the first listener
has the last word.

#### Properties

##### begin?

> `optional` **begin?**: (`pass`, `run`, `isFirstPass`) => `void`

###### Parameters

###### pass

[`Pass`](#pass)

###### run

[`RunState`](#runstate)

###### isFirstPass

`boolean`

###### Returns

`void`

##### close?

> `optional` **close?**: (`run`) => `void`

###### Parameters

###### run

[`RunState`](#runstate)

###### Returns

`void`

##### finish?

> `optional` **finish?**: (`pass`, `nodes`) => `void` \| `Promise`\<`void`\>

###### Parameters

###### pass

[`Pass`](#pass)

###### nodes

[`NodeReport`](#nodereport)[]

###### Returns

`void` \| `Promise`\<`void`\>

##### immediate?

> `optional` **immediate?**: `object`

###### output?

> `optional` **output?**: (`nodeState`, `lines`) => `void`

###### Parameters

###### nodeState

[`NodeState`](#nodestate)

###### lines

`string`[]

###### Returns

`void`

###### start?

> `optional` **start?**: (`nodeState`) => `void`

###### Parameters

###### nodeState

[`InFlightNodeState`](#inflightnodestate)

###### Returns

`void`

##### interrupt?

> `optional` **interrupt?**: (`run`) => `void`

###### Parameters

###### run

[`RunState`](#runstate)

###### Returns

`void`

##### settle?

> `optional` **settle?**: (`nodeState`, `run`, `log`) => `void`

###### Parameters

###### nodeState

[`SettledNodeState`](#settlednodestate)

###### run

[`RunState`](#runstate)

###### log

`string`[]

###### Returns

`void`

##### start?

> `optional` **start?**: (`nodeState`, `run`) => `void`

###### Parameters

###### nodeState

[`InFlightNodeState`](#inflightnodestate)

###### run

[`RunState`](#runstate)

###### Returns

`void`

---

### RunOutcome

#### Properties

##### cancelled

> **cancelled**: `boolean`

##### exitCode

> **exitCode**: `number`

130 after a cancel, as for a Ctrl-C; 1 when a node did not succeed.

##### failed

> **failed**: `number`

##### markdown

> **markdown**: `string`

##### results

> **results**: `Result`[]

---

### RunReport

The run's data, as every renderer gets it. In the post pass it holds the owed post steps alone.

#### Properties

##### log

> **log**: (`name`) => `Promise`\<`string`[]\>

A node's log as its group printed it, read back from the CAS: stdout, stderr, then a failure's error.

###### Parameters

###### name

`string`

###### Returns

`Promise`\<`string`[]\>

##### nodes

> **nodes**: [`NodeReport`](#nodereport)[]

In graph order, which is topological.

---

### RunState

The nodes of every pass (a post pass replaces those it owes) and the last run's durations.

#### Properties

##### lastRunDurations?

> `readonly` `optional` **lastRunDurations?**: `Readonly`\<`Record`\<`string`, `number`\>\>

##### lifecycle

> `readonly` **lifecycle**: [`RunLifecycle`](#runlifecycle)

##### nodes

> `readonly` **nodes**: `ReadonlyMap`\<`string`, [`NodeState`](#nodestate)\>

---

### SaveSpec

What a cache's `save` takes.

#### Properties

##### partial?

> `optional` **partial?**: `"save"` \| `"skip"`

What a run where a task did not succeed saves. `save`, the default: what succeeded, under
`<key>-partial-<run id>`, which the next run's restore finds as a prefix of `key`, so a flaky
test still leaves a cache. `skip`: nothing, as `actions/cache`'s `post-if: success()`. Only a
run where every task succeeded saves under `key`, so a partial save never takes the key. The
save waits for no post step, so a failed post step does not count.

---

### UploadArtifactSpec

The inputs of `actions/upload-artifact`: `name`, `path`, `if-no-files-found`, and those the
store reads, `overwrite`, `retention-days` and `compression-level`.

#### Extends

- [`ArtifactUploadOptions`](#artifactuploadoptions)

#### Type Parameters

##### D

`D` _extends_ `DepRecord` = `DepRecord`

#### Properties

##### artifact

> **artifact**: `string`

The artifact's name on the run page: no `"`, `:`, `<`, `>`, `|`, `*`, `?`, `\\` or `/`.

##### compressionLevel?

> `optional` **compressionLevel?**: `number`

###### Inherited from

[`ArtifactUploadOptions`](#artifactuploadoptions).[`compressionLevel`](#compressionlevel)

##### deps?

> `optional` **deps?**: `D`

##### ifNoFilesFound?

> `optional` **ifNoFilesFound?**: `"warn"` \| `"error"` \| `"ignore"`

What an empty `path` does: a warning and no artifact (the default), a failure, or nothing.

##### name

> **name**: `string`

The node's name; `artifact` is the artifact's.

##### overwrite?

> `optional` **overwrite?**: `boolean`

Delete an artifact of the same name first: a re-run of a failed job shares its run's artifacts.

###### Inherited from

[`ArtifactUploadOptions`](#artifactuploadoptions).[`overwrite`](#overwrite)

##### path

> **path**: readonly `string`[] \| ((`deps`) => readonly `PathItem`[])

Globs as `workflow.glob` takes them, or a function of the deps' outputs, the handles the
upload's action reads when it runs, that names their files too: `deps: { pack }, path: ({ pack
}) => ["reports/**", pack.tarball]`. A `settled` dep that failed is `undefined`, and an
`undefined` item is left out: `({ tests }) => [tests?.report]`.

##### retentionDays?

> `optional` **retentionDays?**: `number`

###### Inherited from

[`ArtifactUploadOptions`](#artifactuploadoptions).[`retentionDays`](#retentiondays)

---

### Workflow

What an implementation adds its nodes through, bound to one graph, ports and CI context.

- A helper that sets `concurrencyGroup: "mix"` takes `Workflow<"mix">`; one that sets no group
  takes `Workflow`.

#### Type Parameters

##### G

`G` _extends_ `string` = `never`

#### Properties

##### cache

> **cache**: (`spec`) => [`ActionsCacheTasks`](#actionscachetasks)

`actions/cache` as tasks: adds the restore, `restore:<name>`, and returns it with `save`,
which adds the save, `save:<name>`, after every other node: see `ActionsCacheTasks`.
`const cas = workflow.cache({ name: "cas", path: [".dag/cas"], key, restoreKeys })`, then
`deps: { cas: cas.restore }` and `cas.save()`.

###### Parameters

###### spec

[`ActionsCacheSpec`](#actionscachespec)

###### Returns

[`ActionsCacheTasks`](#actionscachetasks)

##### compose

> **compose**: \<`R`\>(`other`) => `Promise`\<`R`\>

Adds another workflow's nodes to this graph and returns what its implementation returns:
`const { lint } = await workflow.compose(checks)`. Its `schedulerOptions` do not apply, so
this workflow must declare every concurrency group the other declares.

###### Type Parameters

###### R

`R`

###### Parameters

###### other

[`WorkflowDef`](#workflowdef)\<`R`, `G`\>

###### Returns

`Promise`\<`R`\>

##### ctx

> **ctx**: [`CiContext`](#cicontext)

##### glob

> **glob**: (...`patterns`) => `Promise`\<`Record`\<`string`, `FileInput`\>\>

The files the patterns match as `actions/cache`'s `path:` does, less `DEFAULT_EXCLUDES`, as
`file()` inputs: `inputs: { version: "lint-v1", ...(await workflow.glob("src/**")) }`.

- Start a pattern at the directory it needs, `src/**`: a negation filters but does not prune,
  so `**` walks `node_modules` too.

###### Parameters

###### patterns

...`string`[]

###### Returns

`Promise`\<`Record`\<`string`, `FileInput`\>\>

##### graph

> **graph**: `Graph`\<[`Ports`](#ports)\>

##### hash

> **hash**: (...`patterns`) => `Promise`\<`string`\>

The `hashFiles()` of a workflow file: one hash over the matched files' contents, for a cache key.

###### Parameters

###### patterns

...`string`[]

###### Returns

`Promise`\<`string`\>

##### ports

> **ports**: [`WorkflowPorts`](#workflowports-1)

##### requireAll

> **requireAll**: (`opts`) => [`NodeRef`](#noderef)\<`Record`\<`"outcome"`, `string`\>\>

###### Parameters

###### opts

###### deps

`Record`\<`string`, [`NodeRef`](#noderef)\>

###### name?

`string`

###### Returns

[`NodeRef`](#noderef)\<`Record`\<`"outcome"`, `string`\>\>

##### task

> **task**: \<`D`, `O`, `I`\>(`spec`) => [`NodeRef`](#noderef)\<`Record`\<`O`, `string`\>\>

Adds a node whose work is `action`, `cmd` or `shell`, and its `post` when it gives one: see
`TaskSpec`. `workflow.task({ name: "lint", cmd: ["bun", "run", "lint"], inputs: src })`;
`workflow.task({ name: "up:db", cmd: ["compose", "up"], post: { name: "down:db", cmd:
["compose", "down"] } })`.

###### Type Parameters

###### D

`D` _extends_ `DepRecord` = `Record`\<`never`, `never`\>

###### O

`O` _extends_ `string` = `never`

###### I

`I` _extends_ `InputRecord` = `Record`\<`never`, `never`\>

###### Parameters

###### spec

[`TaskSpec`](#taskspec)\<`G`, `D`, `O`, `I`\>

###### Returns

[`NodeRef`](#noderef)\<`Record`\<`O`, `string`\>\>

##### uploadArtifact

> **uploadArtifact**: \<`D`\>(`spec`) => [`NodeRef`](#noderef)\<`Record`\<`"response"`, `string`\>\>

`actions/upload-artifact` as a node: globs and dep outputs up as one artifact of the run.

###### Type Parameters

###### D

`D` _extends_ `DepRecord` = `Record`\<`never`, `never`\>

###### Parameters

###### spec

[`UploadArtifactSpec`](#uploadartifactspec)\<`D`\>

###### Returns

[`NodeRef`](#noderef)\<`Record`\<`"response"`, `string`\>\>

---

### WorkflowDef

A workflow, as `defineWorkflow` returns it.

#### Type Parameters

##### R

`R` = `unknown`

##### G

`G` _extends_ `string` = `string`

#### Properties

##### \_groups?

> `readonly` `optional` **\_groups?**: `G`

The concurrency groups it declares, for `workflow.compose`'s check; never set.

##### \[WORKFLOW_DEF\]

> `readonly` **\[WORKFLOW_DEF\]**: `true`

##### implementation

> **implementation**: [`Implementation`](#implementation-1)\<`R`\>

##### schedulerOptions?

> `optional` **schedulerOptions?**: `ThrottledSchedulerOptions`

##### summary?

> `optional` **summary?**: readonly [`SummaryRenderer`](#summaryrenderer)[]

## Type Aliases

### ActionTaskSpec

> **ActionTaskSpec**\<`G`, `D`, `O`, `I`\> = `Omit`\<`TaskFields`\<`G`, `D`, `O`, `I`\>, `"inputs"`\> & `object` & `OutputsField`\<`O`\>

What `workflow.task` takes for a node whose work is `action`, a TypeScript function, and
neither `cmd` nor `shell`.

- Its key is its name, its `inputs`, its deps by role and its `outputs`, never its `action`, so
  a renamed task runs again. A value the action reads goes in `inputs`:
  `inputs: { version: "manifest-v1", os }`, then `inputs.os`. Bump the version when the action
  changes.
- It is cached only when it declares inputs, unless it sets `cacheable`.

#### Type Parameters

##### G

`G` _extends_ `string`

##### D

`D` _extends_ `DepRecord`

##### O

`O` _extends_ `string`

##### I

`I` _extends_ `InputRecord` = `Record`\<`never`, `never`\>

#### Type Declaration

##### cmd?

> `optional` **cmd?**: `never`

##### inputs?

> `optional` **inputs?**: `I` & `object`

###### Type Declaration

###### declaredOutputs?

> `optional` **declaredOutputs?**: `never`

##### shell?

> `optional` **shell?**: `never`

---

### AnnotationLevel

> **AnnotationLevel** = `"error"` \| `"warning"` \| `"notice"`

---

### CancelledNodeState

> **CancelledNodeState** = `NodeLines` & `LogRead` & `Readonly`\<`Pick`\<`Extract`\<`Result`, \{ `status`: `"cancelled"`; \}\>, `"status"` \| `"actionKey"`\>\> & `object`

Dispatched or not; `actionKey` is "" for one cancelled before it had one.

#### Type Declaration

##### endedAt

> `readonly` **endedAt**: `number`

##### startedAt?

> `readonly` `optional` **startedAt?**: `number`

---

### CiContext

> **CiContext** = `Pick`\<_typeof_ `context`, `"ref"` \| `"sha"` \| `"eventName"` \| `"actor"` \| `"runId"` \| `"repo"` \| `"serverUrl"`\> & `object`

What the runner knows about the event it is running for: the fields of `@actions/github`'s
`Context` a workflow reads, plus the two the toolkit has no notion of, since it never runs
anywhere but GitHub. Locally, git fills `ref` (`refs/heads/<branch>`, `""` on a detached HEAD),
`sha` and `actor`; the rest is `0` and `""`.

#### Type Declaration

##### isCi

> **isCi**: `boolean`

##### provider

> **provider**: `string`

---

### CmdTaskSpec

> **CmdTaskSpec**\<`G`, `D`, `O`\> = `CommandFields`\<`G`, `D`, `O`\> & `OutputsField`\<`O`\> & `CmdWork`\<`D`, `O`\>

What `workflow.task` takes for a node whose work is `cmd`: one program and its arguments, run
with no shell, and neither `action` nor `shell`.

- A ref is its own argument:
  `cmd: ({ outputDir }) => ["npm", "pack", "--pack-destination", outputDir]`.
- For `--file=` and a path, use `shell`:
  `env: ({ pack }) => ({ FILE: pack.tarball }), shell: 'tool --file="$FILE"'`.

#### Type Parameters

##### G

`G` _extends_ `string`

##### D

`D` _extends_ `DepRecord`

##### O

`O` _extends_ `string`

---

### FailedNodeState

> **FailedNodeState** = `NodeLines` & `LogRead` & `Readonly`\<`Pick`\<`Extract`\<`Result`, \{ `status`: `"failed"`; \}\>, `"status"` \| `"actionKey"`\>\> & `object`

#### Type Declaration

##### command?

> `readonly` `optional` **command?**: [`CommandCause`](#commandcause)

A failed command, from its error's cause.

##### endedAt

> `readonly` **endedAt**: `number`

##### error

> `readonly` **error**: `string`

##### log?

> `readonly` `optional` **log?**: `string`[]

The CAS log, kept for the failure's block and report.

##### startedAt

> `readonly` **startedAt**: `number`

##### timedOut

> `readonly` **timedOut**: `boolean`

---

### GroupsOf

> **GroupsOf**\<`S`\> = `S` _extends_ `object` ? `Extract`\<keyof `C`, `string`\> : `never`

The concurrency groups that scheduler options declare, or `never` when they declare none.

#### Type Parameters

##### S

`S`

---

### Implementation

> **Implementation**\<`R`\> = (`graph`, `ports`, `ctx`) => `Promise`\<`R`\>

An implementation adds nodes to the graph; the ref/event come in `ctx` for conditionals.

#### Type Parameters

##### R

`R` = `unknown`

#### Parameters

##### graph

`Graph`\<[`Ports`](#ports)\>

##### ports

[`Ports`](#ports)

##### ctx

[`CiContext`](#cicontext)

#### Returns

`Promise`\<`R`\>

---

### InFlightNodeState

> **InFlightNodeState** = `NodeLines` & `object`

#### Type Declaration

##### startedAt

> `readonly` **startedAt**: `number`

##### status

> `readonly` **status**: `"dispatched"` \| `"running"`

---

### Lockfile

> **Lockfile** = `Pick`\<_typeof_ `properLockfile`, `"lock"` \| `"check"`\>

proper-lockfile: a run's lock on its history says the run is still going.

---

### NodeAction

> **NodeAction** = `Exclude`\<`ExecEvent`, \{ `type`: `"output"`; \}\> & `object` \| `Extract`\<`ExecEvent`, \{ `type`: `"output"`; \}\> \| \{ `log`: `string`[]; `settled`: [`SettledNodeState`](#settlednodestate); `type`: `"logRead"`; \}

An engine event, stamped with when it came (what a node prints needs no time), or what the
run's own steps add to it.

---

### NodeRef

> **NodeRef**\<`T`\> = `object` & `NotAString`

Handle to a node, returned by `addNode`. `T` is its action's output type.

#### Type Parameters

##### T

`T` _extends_ `Outputs` = `Outputs`

#### Type Declaration

##### \_T?

> `readonly` `optional` **\_T?**: `T`

##### name

> `readonly` **name**: `string`

##### settled?

> `readonly` `optional` **settled?**: `false`

---

### NodeState

> **NodeState** = [`PendingNodeState`](#pendingnodestate) \| [`InFlightNodeState`](#inflightnodestate) \| [`SettledNodeState`](#settlednodestate)

One node as far as the run has got with it. Every duration is `endedAt - startedAt`: from when
its action started, or for a node that settled without starting, such as a cache hit, from its
dispatch. A miss waits for its concurrency group's slot between the two, which is not its time.

---

### OutputRef

> **OutputRef**\<`T`, `S`\> = `object` & `NotAString`

A ref to one output of a required dep, which a node's `inputs` function receives by the dep's
role: `inputs: ({ pack }) => ({ argv: ["npm", "publish", pack.tarball] })`. In a value input it
resolves to a handle on that output's published file, or a list of handles, and keys as the
role it points through and the output's name. `S` is the scope of the call that received it:
the ref goes only in what that call returns, so another node's ref does not compile.

#### Type Parameters

##### T

`T` _extends_ `string` \| `string`[] = `string` \| `string`[]

##### S

`S` = `unknown`

#### Type Declaration

##### \_scope?

> `readonly` `optional` **\_scope?**: `S`

##### \_T?

> `readonly` `optional` **\_T?**: `T`

##### \[OUTPUT_REF\]

> `readonly` **\[OUTPUT_REF\]**: `true`

##### node

> `readonly` **node**: `string`

##### output

> `readonly` **output**: `string`

##### settled

> `readonly` **settled**: `false`

---

### PendingNodeState

> **PendingNodeState** = `NodeLines` & `object`

#### Type Declaration

##### status

> `readonly` **status**: `"pending"`

---

### PostField

> **PostField**\<`O`\> = \{ `post?`: `never`; \} \| \{ `cacheable?`: `never`; `inputs?`: `never`; `post`: [`PostSpec`](#postspec)\<`O`\>; \}

A task's `post`, or none. A task with a `post` is never cached, so it takes no `inputs` or
`cacheable`: a cache hit starts nothing, and would leave nothing to release.

#### Type Parameters

##### O

`O` _extends_ `string`

---

### PostSpec

> **PostSpec**\<`O`\> = `PostFields` & (\{ `action`: `TaskFields`\<`never`, `MainDep`\<`O`\>, `never`\>\[`"action"`\]; `cmd?`: `never`; `cwd?`: `never`; `env?`: `never`; `shell?`: `never`; \} \| `PostCommandFields`\<`O`\> & `CmdWork`\<`MainDep`\<`O`\>, `never`\> \| `PostCommandFields`\<`O`\> & `ShellWork`)

What a task's `post` takes: its release, as a GitHub action's `post:` releases what its `main:`
set up. Its work is an `action`, a `cmd` or a `shell`, as a task's.

- It is owed once its task started, and runs after the task, whatever the task did, and after
  every node of the run that depends on the task. After a cancel it still runs; a run that stops
  before it leaves it to the next run of the workflow, which runs it before any task.
- It reads its task's outputs as `main`, which a task that failed or was stopped may not have
  written: read them in `env`, where a missing one is unset, `env: ({ main }) => ({ ID: main.id
})`, then `if [ -n "${ID:-}" ]; then docker rm -f "$(cat "$ID")"; fi`.
- It takes no deps: what it needs, its task depends on, so whenever it is owed it can run.
- A failed try runs again (`retry`). When every try failed, it stays owed, the run fails, and
  the next run runs it before any task. Its work must be safe to do twice, as `docker rm -f` is.

#### Type Parameters

##### O

`O` _extends_ `string` = `string`

---

### RunAction

> **RunAction** = [`NodeAction`](#nodeaction) \| \{ `pass`: [`Pass`](#pass); `type`: `"passBegun"`; \} \| \{ `type`: `"runCancelled"`; \} \| \{ `type`: `"runClosed"`; \} \| \{ `error`: `string`; `type`: `"runErrored"`; \} \| \{ `type`: `"runInterrupted"`; \} \| \{ `durations`: `Record`\<`string`, `number`\>; `type`: `"lastRunRead"`; \}

---

### RunHistory

> **RunHistory** = `Record`\<`string`, `Result`\>

Each settled node's result: what a later process needs to feed its dependents.

---

### RunLifecycle

> **RunLifecycle** = \{ `status`: `"running"` \| `"cancelling"` \| `"finished"` \| `"cancelled"` \| `"interrupted"`; \} \| \{ `error`: `string`; `status`: `"errored"`; \}

How the run stands: running until a cancel or its close, then final. Only an errored run has an error.

---

### RunOptions

> **RunOptions** = `Pick`\<`ExecuteOptions`, `"force"` \| `"signal"`\> & `Pick`\<[`WorkflowDef`](#workflowdef), `"implementation"` \| `"schedulerOptions"` \| `"summary"`\> & `object`

A run's options: its workflow's `implementation`, `schedulerOptions` and `summary` (the post pass
draws with the same), `execute`'s `force` and `signal`, and these.

#### Type Declaration

##### casBaseDir

> **casBaseDir**: `string`

##### historyDir?

> `optional` **historyDir?**: `string`

The directory where each run writes its history; the post pass reads them.

##### only?

> `optional` **only?**: `string`[]

##### ports

> **ports**: [`Ports`](#ports)

##### rerunCommand?

> `optional` **rerunCommand?**: `string`

The command that reruns the workflow; RERUN_COMMAND and the file by default.

##### store?

> `optional` **store?**: [`RunStore`](#runstore)

What the passes report to: the GitHub renderer on `ports.host` unless given.

##### workflowFile?

> `optional` **workflowFile?**: `string`

The workflow file as given: named in the summary's heading and in the log's reproduce line.

---

### RunStore

> **RunStore** = `ReturnType`\<_typeof_ [`createRunStore`](#createrunstore)\>

---

### SettledNodeState

> **SettledNodeState** = [`SucceededNodeState`](#succeedednodestate) \| [`FailedNodeState`](#failednodestate) \| [`SkippedNodeState`](#skippednodestate) \| [`CancelledNodeState`](#cancellednodestate)

---

### SettledOutputRef

> **SettledOutputRef**\<`T`, `S`\> = `object` & `NotAString`

A ref to one output of a `settled` dep, which resolves to `undefined` when the dep did not
succeed. It never stands where an `OutputRef` is declared.

#### Type Parameters

##### T

`T` _extends_ `string` \| `string`[] = `string` \| `string`[]

##### S

`S` = `unknown`

#### Type Declaration

##### \_scope?

> `readonly` `optional` **\_scope?**: `S`

##### \_T?

> `readonly` `optional` **\_T?**: `T`

##### \[OUTPUT_REF\]

> `readonly` **\[OUTPUT_REF\]**: `true`

##### node

> `readonly` **node**: `string`

##### output

> `readonly` **output**: `string`

##### settled

> `readonly` **settled**: `true`

---

### SettledRef

> **SettledRef**\<`T`\> = `object` & `NotAString`

A dep its node runs without when it does not succeed, as `Promise.allSettled` waits.

#### Type Parameters

##### T

`T` _extends_ `Outputs` = `Outputs`

#### Type Declaration

##### \_T?

> `readonly` `optional` **\_T?**: `T`

##### name

> `readonly` **name**: `string`

##### settled

> `readonly` **settled**: `true`

---

### ShellTaskSpec

> **ShellTaskSpec**\<`G`, `D`, `O`\> = `CommandFields`\<`G`, `D`, `O`\> & `OutputsField`\<`O`\> & `ShellWork`

What `workflow.task` takes for a node whose work is `shell`: one string, run under
`bash --noprofile --norc -eo pipefail -c` (GitHub's `shell: bash`), so a failing command or pipe
stage fails the node; and neither `action` nor `cmd`.

- Every ref, `outputDir` too, reaches the string only through `env`, read quoted:
  `env: ({ assets }) => ({ BUNDLE: assets.bundle }), shell: 'gzip -c "$BUNDLE" | wc -c'`.
- A `settled` dep's output in `env` is unset when the dep did not succeed, so test it:
  `env: ({ tests }) => ({ REPORT: tests.report }), shell: 'if [ -n "$REPORT" ]; then cat "$REPORT"; fi'`.

#### Type Parameters

##### G

`G` _extends_ `string`

##### D

`D` _extends_ `DepRecord`

##### O

`O` _extends_ `string`

---

### SkippedNodeState

> **SkippedNodeState** = `NodeLines` & `LogRead` & `object`

Skipped because a dependency failed: never dispatched.

#### Type Declaration

##### endedAt

> `readonly` **endedAt**: `number`

##### error

> `readonly` **error**: `string`

##### status

> `readonly` **status**: `"dep-failed"`

---

### SucceededNodeState

> **SucceededNodeState** = `NodeLines` & `LogRead` & `Readonly`\<`Pick`\<`SucceededResult`, `"status"` \| `"actionKey"` \| `"outputs"`\>\> & `object`

#### Type Declaration

##### endedAt

> `readonly` **endedAt**: `number`

##### startedAt

> `readonly` **startedAt**: `number`

---

### SummaryRenderer

> **SummaryRenderer** = (`report`) => `string`[] \| `Promise`\<`string`[]\>

Renders one block of the step summary from the run's data, as markdown lines. [] renders nothing.

#### Parameters

##### report

[`RunReport`](#runreport)

#### Returns

`string`[] \| `Promise`\<`string`[]\>

---

### TaskSpec

> **TaskSpec**\<`G`, `D`, `O`, `I`\> = ([`ActionTaskSpec`](#actiontaskspec)\<`G`, `D`, `O`, `I`\> \| [`CmdTaskSpec`](#cmdtaskspec)\<`G`, `D`, `O`\> \| [`ShellTaskSpec`](#shelltaskspec)\<`G`, `D`, `O`\>) & [`PostField`](#postfield)\<`O`\>

What `workflow.task` takes: a node whose work is exactly one of `action`, a TypeScript function
(`ActionTaskSpec`); `cmd`, an argv run with no shell (`CmdTaskSpec`); or `shell`, a string
run under bash (`ShellTaskSpec`). Giving two does not compile. A task that sets something up
that must be undone, as a database container, gives its release as `post` (`PostSpec`), and is
then never cached.

#### Type Parameters

##### G

`G` _extends_ `string`

##### D

`D` _extends_ `DepRecord`

##### O

`O` _extends_ `string`

##### I

`I` _extends_ `InputRecord` = `Record`\<`never`, `never`\>

---

### WorkflowPorts

> **WorkflowPorts** = `Omit`\<[`Ports`](#ports), `"exec"`\>

The ports a workflow and its tasks read, `workflow.ports` and an action's `ports`: every port
but `exec`. A command runs only inside a node, through its shell (`run` and `runShell`, or a
`cmd` or `shell` task), where its log, timeout and cancel apply; only the shell and the
adapters use `exec`.

## Variables

### DEFAULT_CAS_DIR

> `const` **DEFAULT_CAS_DIR**: `".dag/cas"` = `".dag/cas"`

Local CAS directory, relative to the repo root. Carried between runs by actions/cache nodes in the workflow.

---

### DEFAULT_EXCLUDES

> `const` **DEFAULT_EXCLUDES**: `string`[]

Directories `workflow.glob` leaves out. Leave out others with a negation: `!dist/**`.

---

### DEFAULT_HISTORY_DIR

> `const` **DEFAULT_HISTORY_DIR**: `".dag/history"` = `".dag/history"`

Each run writes its history, its settled nodes, here as they settle; `dag post` reads them.

---

### DEFAULT_SUMMARY_PATH

> `const` **DEFAULT_SUMMARY_PATH**: `".dag/summary.md"` = `".dag/summary.md"`

Where the local adapter writes the markdown summary GitHub would render on the run page.

---

### DEFAULT_SUMMARY_RENDERERS

> `const` **DEFAULT_SUMMARY_RENDERERS**: readonly [`SummaryRenderer`](#summaryrenderer)[]

The step summary's renderers, top to bottom, for a workflow that sets no `summary`. The node
table is left out; `[...DEFAULT_SUMMARY_RENDERERS, renderTable]` puts it back at the bottom.

---

### nullArtifactStore

> `const` **nullArtifactStore**: [`ArtifactStore`](#artifactstore)

No artifact store: every upload is a no-op. The local default.

---

### nullCacheStore

> `const` **nullCacheStore**: [`CacheStore`](#cachestore)

No cache store: every restore misses and every save is a no-op. A GitHub run that cannot reach
the cache service gets it.

---

### okExec

> `const` **okExec**: [`Exec`](#exec)

An Exec where every command succeeds silently.

## Functions

### abortOnSignals()

> **abortOnSignals**(): `AbortSignal`

A signal to abort on SIGINT, SIGTERM or SIGHUP: Ctrl-C or a closed terminal locally, and on
GitHub the runner's SIGINT to the step, then its SIGTERM 7500 ms later. Each cancels the run:
waiting nodes settle as cancelled, running commands are interrupted, and the process exits once
they have stopped. A second signal SIGKILLs the process group of every command still running,
which no terminal signal reaches since each runs in a session of its own, and exits at once; the
next run finishes the post steps it owes.

#### Returns

`AbortSignal`

---

### artifactServiceAvailable()

> **artifactServiceAvailable**(`env`): `boolean`

`@actions/artifact` reaches the service with the runtime token and results URL the runner hands a JavaScript action.

#### Parameters

##### env

`Readonly`\<`ProcessEnv`\>

#### Returns

`boolean`

---

### clockAt()

> **clockAt**(`now?`): [`Clock`](#clock)

A clock that reads its time from `now` and whose sleep ends at once: `clockAt(() => now)`.

#### Parameters

##### now?

() => `number`

#### Returns

[`Clock`](#clock)

---

### createActionsArtifactStore()

> **createActionsArtifactStore**(`client`): [`ArtifactStore`](#artifactstore)

The GitHub artifact store: an `@actions/artifact` client as an ArtifactStore. An `overwrite`
upload deletes the artifact of its name first, if the run has one.

#### Parameters

##### client

`Pick`\<`ArtifactClient`, `"uploadArtifact"` \| `"deleteArtifact"`\>

#### Returns

[`ArtifactStore`](#artifactstore)

---

### createActionsCacheStore()

> **createActionsCacheStore**(`cache`): [`CacheStore`](#cachestore)

The GitHub cache store: `@actions/cache` as a CacheStore. A save asks the service first, and
saves only a key it does not hold, compared as actions/cache's isExactKeyMatch does, case aside:
the service also matches a key as a prefix. A save whose lookup fails saves anyway.

#### Parameters

##### cache

`Pick`\<_typeof_ `actionsCache`, `"restoreCache"` \| `"saveCache"`\>

#### Returns

[`CacheStore`](#cachestore)

---

### createExec()

> **createExec**(`opts?`): [`Exec`](#exec)

The real Exec. A cancelled command is interrupted the way GitHub's runner interrupts a step:
SIGINT, SIGTERM after `sigintGraceMs`, SIGKILL after `sigtermGraceMs` more. Each command runs
in a process group of its own and the signals go to the group, so what it started stops with
it. Once a cancelled command exits, what is left of its group, such as a background job, which
ignores SIGINT, gets SIGTERM and, if it is still there `sigtermGraceMs` later, SIGKILL, as
systemd stops a unit; the command settles when the group is gone. A command killed by a signal
resolves with code -1 and the signal's name on stderr and at the end of `output`.
A process the command left behind holding its output (a server started with `&`) is cut off
`streamDrainGraceMs` after the command exits, so neither it nor a killed command's orphan keeps
the node running.

#### Parameters

##### opts?

###### sigintGraceMs?

`number`

###### sigtermGraceMs?

`number`

###### streamDrainGraceMs?

`number`

#### Returns

[`Exec`](#exec)

---

### createLocalHost()

> **createLocalHost**(`opts`): [`Host`](#host)

Local adapter: the same reporter output as GitHub, rendered for a terminal. Groups become
indented blocks, annotations become tagged lines, and the summary is written to a file.
Context comes from git: `ref` in the toolkit's form, `refs/heads/<branch>`, or "" on a detached
HEAD, as GitHub leaves it unset for an event with no branch or tag. This is what makes
`bun run ci` on a laptop identical to the job.

#### Parameters

##### opts

`Pick`\<[`Ports`](#ports), `"fs"` \| `"exec"`\> & `object`

#### Returns

[`Host`](#host)

---

### createMemoryArtifactStore()

> **createMemoryArtifactStore**(): [`MemoryArtifactStore`](#memoryartifactstore)

An in-memory artifact store for tests, with the service's rules: a name uploads once per run,
so a second upload under the same name is refused unless it overwrites. It records names and
paths and reads no files.

#### Returns

[`MemoryArtifactStore`](#memoryartifactstore)

---

### createMemoryCacheStore()

> **createMemoryCacheStore**(`initialKeys?`): [`MemoryCacheStore`](#memorycachestore)

An in-memory cache store for tests, with the service's matching rules: the primary key exactly,
else the primary key and then each restore key as a prefix, newest entry first. Saving an
existing key is a no-op, as on GitHub; deleting from `entries` is an eviction. It records keys
and paths and moves no files.

#### Parameters

##### initialKeys?

`string`[] = `[]`

#### Returns

[`MemoryCacheStore`](#memorycachestore)

---

### createRecordingHost()

> **createRecordingHost**(`context?`): [`RecordedHost`](#recordedhost)

A Host that records every call, so tests can assert the exact reporter output.

#### Parameters

##### context?

`Partial`\<[`CiContext`](#cicontext)\> = `{}`

#### Returns

[`RecordedHost`](#recordedhost)

---

### createReporter()

> **createReporter**(`ports`, `opts`): `object`

Turns dagraph's event stream into CI output as the GitHub renderer draws it
(github/renderer.ts), with a markdown summary drawn by the renderers in `summary`
(summary.ts). `rerunCommand` is the command that ran this workflow, for the recap's reproduce line.
Logs are read back from beside the CAS, which is why cached and failed nodes still show their output.

#### Parameters

##### ports

[`Ports`](#ports)

##### opts

###### casBaseDir

`string`

###### nodes

`Node`\<`unknown`\>[]

###### rerunCommand?

`string`

###### summary?

readonly [`SummaryRenderer`](#summaryrenderer)[]

###### title?

`string`

#### Returns

`object`

##### finish

> **finish**: (`results`) => `Promise`\<\{ `failed`: `number`; `markdown`: `string`; \}\>

###### Parameters

###### results

`Result`[]

###### Returns

`Promise`\<\{ `failed`: `number`; `markdown`: `string`; \}\>

##### onEvent

> **onEvent**: (`event`) => `void` = `store.onEvent`

###### Parameters

###### event

`ExecEvent`

###### Returns

`void`

---

### createRunHistory()

> **createRunHistory**(`fs`, `lockfile`, `dir`, `initial`): `Promise`\<\{ `begin`: () => `Promise`\<`void`\>; `close`: () => `Promise`\<`void`\>; `flush`: () => `Promise`\<`void`\>; `onEvent`: (`event`) => `Promise`\<`void`\> \| `undefined`; `path`: `string`; `results`: [`RunHistory`](#runhistory); `started`: `string`[]; \}\>

A run's own history in `dir`, so runs at the same time never write one file: every node that
settled, written as nodes settle, so a run the runner interrupts or kills still leaves a
consistent record. Each write goes beside the file and is renamed over it, so a write a kill
cuts short leaves the last whole one. The run holds its history's lock until it is `close`d;
a history it left then shows a later pass what it still owes.

#### Parameters

##### fs

`DagFs`

##### lockfile

[`Lockfile`](#lockfile-1)

##### dir

`string`

##### initial

[`RunHistoryFile`](#runhistoryfile)

#### Returns

`Promise`\<\{ `begin`: () => `Promise`\<`void`\>; `close`: () => `Promise`\<`void`\>; `flush`: () => `Promise`\<`void`\>; `onEvent`: (`event`) => `Promise`\<`void`\> \| `undefined`; `path`: `string`; `results`: [`RunHistory`](#runhistory); `started`: `string`[]; \}\>

---

### createRunStore()

> **createRunStore**(`opts`): `object`

The run every output reads: `runReducer`'s state, and its listeners told of each action. Its IO
is the CAS: a settled node's log, and last-run.json, read before its first write (a node may
restore the CAS that holds it) or, given `lastRunAtBegin`, as the run begins, and written as
nodes settle, so a CAS saved in the graph carries it.

#### Parameters

##### opts

`Pick`\<[`Ports`](#ports), `"fs"` \| `"clock"`\> & `object`

#### Returns

##### begin

> **begin**: (`pass`) => `void`

###### Parameters

###### pass

[`Pass`](#pass)

###### Returns

`void`

##### cancel

> **cancel**: () => `void`

###### Returns

`void`

##### close

> **close**: (`error?`) => `Promise`\<`void`\>

###### Parameters

###### error?

`unknown`

###### Returns

`Promise`\<`void`\>

##### dispatch

> **dispatch**: (`action`) => `void`

###### Parameters

###### action

[`RunAction`](#runaction)

###### Returns

`void`

##### finish

> **finish**: (`pass`, `reports`) => `Promise`\<`void`\>

###### Parameters

###### pass

[`Pass`](#pass)

###### reports

[`NodeReport`](#nodereport)[]

###### Returns

`Promise`\<`void`\>

##### getState

> **getState**: () => [`RunState`](#runstate)

###### Returns

[`RunState`](#runstate)

##### interrupt

> **interrupt**: () => `void`

###### Returns

`void`

##### log

> **log**: (`name`) => `Promise`\<`string`[]\>

A node's log as its group prints it, read back from the CAS.

###### Parameters

###### name

`string`

###### Returns

`Promise`\<`string`[]\>

##### onEvent

> **onEvent**: (`event`) => `void`

###### Parameters

###### event

`ExecEvent`

###### Returns

`void`

##### report

> **report**: (`pass`) => `Promise`\<[`NodeReport`](#nodereport)[]\>

`pass`'s nodes, once every settle is told and the last run's durations are known.

###### Parameters

###### pass

[`Pass`](#pass)

###### Returns

`Promise`\<[`NodeReport`](#nodereport)[]\>

---

### createTestPorts()

> **createTestPorts**(`opts?`): `object`

Ports built from doubles: the one fixture every dagworkflows test starts from.

#### Parameters

##### opts?

`Partial`\<`Pick`\<[`Ports`](#ports), `"exec"` \| `"clock"` \| `"env"`\>\> & `object` = `{}`

#### Returns

`object`

##### artifactStore

> **artifactStore**: [`MemoryArtifactStore`](#memoryartifactstore)

##### cacheStore

> **cacheStore**: [`MemoryCacheStore`](#memorycachestore)

##### fs

> **fs**: `MemoryDagFs`

##### ports

> **ports**: [`Ports`](#ports)

##### rec

> **rec**: [`RecordedHost`](#recordedhost)

---

### createWorkflow()

> **createWorkflow**\<`G`\>(`graph`, `ports`, `ctx`): [`Workflow`](#workflow-1)\<`G`\>

#### Type Parameters

##### G

`G` _extends_ `string`

#### Parameters

##### graph

`Graph`\<[`Ports`](#ports)\>

##### ports

[`Ports`](#ports)

##### ctx

[`CiContext`](#cicontext)

#### Returns

[`Workflow`](#workflow-1)\<`G`\>

---

### defineWorkflow()

> **defineWorkflow**\<`S`, `R`\>(`def`): [`WorkflowDef`](#workflowdef)\<`R`, [`GroupsOf`](#groupsof)\<`S`\>\>

Declares a workflow, what a workflow file default-exports:
`export default defineWorkflow({ implementation: (workflow) => { ... } })`. `summary` defaults
to `DEFAULT_SUMMARY_RENDERERS`.

#### Type Parameters

##### S

`S` _extends_ `ThrottledSchedulerOptions`

##### R

`R` = `void`

#### Parameters

##### def

###### implementation

(`workflow`) => `R` \| `Promise`\<`R`\>

###### schedulerOptions?

`S`

###### summary?

readonly [`SummaryRenderer`](#summaryrenderer)[]

#### Returns

[`WorkflowDef`](#workflowdef)\<`R`, [`GroupsOf`](#groupsof)\<`S`\>\>

---

### file()

> **file**(`path`): `FileInput`

A file input, read by the action as a handle on the file.

#### Parameters

##### path

`string`

#### Returns

`FileInput`

---

### formatDuration()

> **formatDuration**(`ms`): `string`

#### Parameters

##### ms

`number`

#### Returns

`string`

---

### hashFiles()

> **hashFiles**(`patterns`): `Promise`\<`string`\>

#### Parameters

##### patterns

`string`[]

#### Returns

`Promise`\<`string`\>

---

### logPath()

> **logPath**(`casBaseDir`, `actionKey`): `string`

Where a step stores its log, stdout and stderr as they arrived, for the reporter: beside the
CAS, never in it, since the CAS goes into a cache any pull request can restore and nothing
masks what a command printed. Keyed by the action key, so a cached node shows the log of the
run that built it: the CAS `/cas` keeps the log of key `k` in `/cas.logs/k.log`.

#### Parameters

##### casBaseDir

`string`

##### actionKey

`string`

#### Returns

`string`

---

### nullHost()

> **nullHost**(): [`Host`](#host)

A Host that does nothing — for library users who only want the results.

#### Returns

[`Host`](#host)

---

### postNodes()

> **postNodes**(`graph`): `Map`\<`string`, `string`\>

Each post of the graph, by name, with its main's: `dag post` runs the ones a run still owes.

#### Parameters

##### graph

`StepGraph`

#### Returns

`Map`\<`string`, `string`\>

---

### readRunHistory()

> **readRunHistory**(`fs`, `path`): `Promise`\<[`RunHistoryFile`](#runhistoryfile)\>

#### Parameters

##### fs

`DagFs`

##### path

`string`

#### Returns

`Promise`\<[`RunHistoryFile`](#runhistoryfile)\>

---

### renderCriticalPath()

> **renderCriticalPath**(`__namedParameters`): `string`[]

One line: the longest chain by duration, of nodes that took CRITICAL_PATH_FLOOR_MS or more.

#### Parameters

##### \_\_namedParameters

[`RunReport`](#runreport)

#### Returns

`string`[]

---

### renderDag()

> **renderDag**(`__namedParameters`): `string`[]

The DAG as a mermaid flowchart colored by status. Pass it a filtered report to draw part of
the graph: `renderDag({ ...r, nodes: r.nodes.filter(keep) })`.

#### Parameters

##### \_\_namedParameters

[`RunReport`](#runreport)

#### Returns

`string`[]

---

### renderFailures()

> **renderFailures**(`__namedParameters`): `Promise`\<`string`[]\>

Each failed node's log tail in a collapsed block, and one line per skipped or cancelled node,
in graph order: a failure's cause comes before what it broke.

#### Parameters

##### \_\_namedParameters

[`RunReport`](#runreport)

#### Returns

`Promise`\<`string`[]\>

---

### renderStatus()

> **renderStatus**(`__namedParameters`): `string`[]

The outcome as a headline (the failures' causes, or that every node succeeded), then counts,
wall time, parallelism, cache hits and the time they saved.

#### Parameters

##### \_\_namedParameters

[`RunReport`](#runreport)

#### Returns

`string`[]

---

### renderTable()

> **renderTable**(`__namedParameters`): `string`[]

Node, status, duration and the change against the previous run.

#### Parameters

##### \_\_namedParameters

[`RunReport`](#runreport)

#### Returns

`string`[]

---

### renderTimeline()

> **renderTimeline**(`__namedParameters`): `string`[]

A mermaid gantt of the nodes that ran: what happened when, and what overlapped.

#### Parameters

##### \_\_namedParameters

[`RunReport`](#runreport)

#### Returns

`string`[]

---

### runHistoryLive()

> **runHistoryLive**(`lockfile`, `path`): `Promise`\<`boolean`\>

Whether the run whose history is at `path` still runs: it holds a lock beside its history,
which it refreshes while it runs and releases when it exits, and which goes stale once a kill
stops it. The lock is a directory, so it holds across processes, containers and hosts sharing
the history.

#### Parameters

##### lockfile

[`Lockfile`](#lockfile-1)

##### path

`string`

#### Returns

`Promise`\<`boolean`\>

---

### runJob()

> **runJob**(`opts`, `processEvents`): `Promise`\<`number`\>

The job as one process runs it, which the action splits between its `main` and `post`: the
run; after a cancel, the post steps it owes, drawn as the run is; then the store's close, with
what either pass threw. An exit of `processEvents` before the close is done is a forced one (a second
Ctrl-C), and interrupts the store. Resolves to the run's exit code.

#### Parameters

##### opts

[`RunOptions`](#runoptions)

##### processEvents

`Pick`\<`NodeJS.EventEmitter`, `"once"` \| `"off"`\>

#### Returns

`Promise`\<`number`\>

---

### runPost()

> **runPost**(`opts`): `Promise`\<[`RunOutcome`](#runoutcome)\>

The action's `post:`, and `dag run`'s after a cancel: run the post steps that runs no
longer going owe, with what they depend on replayed from each run's history so the engine's
dependency rules apply as they would have. A run whose post steps all succeeded owes nothing
and leaves no history, so nothing runs after it.

#### Parameters

##### opts

`PostOptions`

#### Returns

`Promise`\<[`RunOutcome`](#runoutcome)\>

---

### runWorkflow()

> **runWorkflow**(`opts`): `Promise`\<[`RunOutcome`](#runoutcome)\>

#### Parameters

##### opts

[`RunOptions`](#runoptions)

#### Returns

`Promise`\<[`RunOutcome`](#runoutcome)\>

---

### selectNodes()

> **selectNodes**(`graph`, `names?`, `paying?`): `Graph`\<[`Ports`](#ports)\>

The graph a run executes, of `names` (every node unless given): the engine's `closure` of them,
with the posts of every main in it and the saves of every restore in it. Each post then waits,
by a settled dep, for every node of the run downstream of its main, posts of other mains
included, but not for the other posts of its own main. Each save waits for every other node of
the run but the posts and the saves. Nothing depends on a post or a save, so they go last.

A post requires what its main requires, so it is skipped when its main never started. `paying`
builds the graph of a post pass instead: there an owed post's main started, so the post needs
only its main, and a dep that the workflow file has added to the main since cannot hold it back.

#### Parameters

##### graph

`Graph`\<[`Ports`](#ports)\>

##### names?

`Iterable`\<`string`, `any`, `any`\>

##### paying?

`boolean` = `false`

#### Returns

`Graph`\<[`Ports`](#ports)\>

---

### settled()

#### Call Signature

> **settled**\<`T`\>(`ref`): [`SettledRef`](#settledref)\<`T`\>

Mark a dep its node runs without: when it does not succeed, its role is `undefined`. An action
declares the role with it, around the action that fills it, `deps: { captions:
settled(captions) }`, or uncalled, by the outputs of a role more than one action fills, `deps:
{ captions: settled<string> }`. Its node marks the ref it gives, `deps: { captions:
settled(captionsRef) }`: a role declared one way takes no ref of the other.

##### Type Parameters

###### T

`T` _extends_ `Outputs`

##### Parameters

###### ref

[`NodeRef`](#noderef)\<`T`\>

##### Returns

[`SettledRef`](#settledref)\<`T`\>

#### Call Signature

> **settled**\<`T`\>(`dep`): `SettledDep`\<`T`\>

Mark a dep its node runs without: when it does not succeed, its role is `undefined`. An action
declares the role with it, around the action that fills it, `deps: { captions:
settled(captions) }`, or uncalled, by the outputs of a role more than one action fills, `deps:
{ captions: settled<string> }`. Its node marks the ref it gives, `deps: { captions:
settled(captionsRef) }`: a role declared one way takes no ref of the other.

##### Type Parameters

###### T

`T` _extends_ `Outputs`

##### Parameters

###### dep

`Dep`\<`T`\>

##### Returns

`SettledDep`\<`T`\>

#### Call Signature

> **settled**\<`T`\>(): `SettledDep`\<`T`\>

Mark a dep its node runs without: when it does not succeed, its role is `undefined`. An action
declares the role with it, around the action that fills it, `deps: { captions:
settled(captions) }`, or uncalled, by the outputs of a role more than one action fills, `deps:
{ captions: settled<string> }`. Its node marks the ref it gives, `deps: { captions:
settled(captionsRef) }`: a role declared one way takes no ref of the other.

##### Type Parameters

###### T

`T` _extends_ `Outputs`

##### Returns

`SettledDep`\<`T`\>

---

### steppingClock()

> **steppingClock**(`start?`, `step?`): [`Clock`](#clock)

Deterministic clock: each call advances by `step`, and a sleep ends at once.

#### Parameters

##### start?

`number` = `0`

##### step?

`number` = `1000`

#### Returns

[`Clock`](#clock)

---

### systemClock()

> **systemClock**(): [`Clock`](#clock)

#### Returns

[`Clock`](#clock)
