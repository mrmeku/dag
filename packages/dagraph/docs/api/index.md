[**@mrmeku/dagraph**](README.md)

---

[@mrmeku/dagraph](README.md) / index

# index

## Classes

### FsCache

Filesystem-backed cache. Stores manifests as JSON at {baseDir}/{actionKey}/manifest.json, each
written beside it and renamed into place, so a reader never sees half of one.

#### Implements

- [`Cache`](#cache)

#### Constructors

##### Constructor

> **new FsCache**(`baseDir`, `fs`): [`FsCache`](#fscache)

###### Parameters

###### baseDir

`string`

###### fs

[`DagFs`](#dagfs)

###### Returns

[`FsCache`](#fscache)

#### Methods

##### get()

> **get**(`key`): `Promise`\<[`CacheEntry`](#cacheentry) \| `undefined`\>

###### Parameters

###### key

`string`

###### Returns

`Promise`\<[`CacheEntry`](#cacheentry) \| `undefined`\>

###### Implementation of

[`Cache`](#cache).[`get`](#get-2)

##### put()

> **put**(`key`, `entry`): `Promise`\<`void`\>

###### Parameters

###### key

`string`

###### entry

[`CacheEntry`](#cacheentry)

###### Returns

`Promise`\<`void`\>

###### Implementation of

[`Cache`](#cache).[`put`](#put-2)

---

### Graph

Nodes and their deps, typed by the ports their actions need and the metadata its nodes carry.
`addNode` adds a node; `describe()` is the one view of a graph.

#### Type Parameters

##### Ports

`Ports` = `unknown`

##### Meta

`Meta` = `undefined`

#### Constructors

##### Constructor

> **new Graph**\<`Ports`, `Meta`\>(): [`Graph`](#graph)\<`Ports`, `Meta`\>

###### Returns

[`Graph`](#graph)\<`Ports`, `Meta`\>

#### Properties

##### \_meta?

> `readonly` `optional` **\_meta?**: (`meta`) => `Meta`

###### Parameters

###### meta

`Meta`

###### Returns

`Meta`

##### \_ports?

> `readonly` `optional` **\_ports?**: (`ports`) => `Ports`

###### Parameters

###### ports

`Ports`

###### Returns

`Ports`

#### Methods

##### describe()

> **describe**(): [`Node`](#node)\<`Meta`\>[]

Each node as data, in the order they were added.

###### Returns

[`Node`](#node)\<`Meta`\>[]

##### subgraph()

> **subgraph**(`prefix`, `meta?`): [`Graph`](#graph)\<`Ports`, `Meta`\>

A view of this graph that prefixes `prefix:` to the name of each node added through it and
gives each its `meta`, unless the node gives its own. Without `meta`, its parent's applies.
It holds the nodes under its prefix and every node they depend on.

###### Parameters

###### prefix

`string`

###### meta?

`Meta`

###### Returns

[`Graph`](#graph)\<`Ports`, `Meta`\>

---

### MemCache

In-memory cache for testing. Entries are lost when the process exits.

#### Implements

- [`Cache`](#cache)

#### Constructors

##### Constructor

> **new MemCache**(): [`MemCache`](#memcache)

###### Returns

[`MemCache`](#memcache)

#### Methods

##### get()

> **get**(`key`): `Promise`\<[`CacheEntry`](#cacheentry) \| `undefined`\>

###### Parameters

###### key

`string`

###### Returns

`Promise`\<[`CacheEntry`](#cacheentry) \| `undefined`\>

###### Implementation of

[`Cache`](#cache).[`get`](#get-2)

##### put()

> **put**(`key`, `entry`): `Promise`\<`void`\>

###### Parameters

###### key

`string`

###### entry

[`CacheEntry`](#cacheentry)

###### Returns

`Promise`\<`void`\>

###### Implementation of

[`Cache`](#cache).[`put`](#put-2)

## Interfaces

### Action

A kind of work, defined once. `addNode` adds one of its nodes to a graph and returns a ref to
it, a `NodeRef<R>`. `R` is its outputs, `D` its deps, `N` its node inputs and `I` its own inputs,
each as its spec declares them; `ND` and `NI`, inferred from the node, are the deps and the
inputs it gives.

#### Type Parameters

##### Ports

`Ports`

##### R

`R` _extends_ [`Outputs`](#outputs-1)

##### D

`D` = `Empty`

##### N

`N` = `Empty`

##### I

`I` = `Empty`

#### Properties

##### \_ports?

> `readonly` `optional` **\_ports?**: (`ports`) => `void`

It takes its ports, so an action is never typed as one that needs fewer.

###### Parameters

###### ports

`Ports`

###### Returns

`void`

##### \_T?

> `readonly` `optional` **\_T?**: `R`

##### \[DEP\]

> `readonly` **\[DEP\]**: `true`

An action is a dep: `deps: { fetch }` declares a role that a node of `fetch` fills.

##### addNode

> `readonly` **addNode**: \<`GraphPorts`, `Meta`, `ND`, `NI`\>(`graph`, `params`) => [`NodeRef`](#noderef)\<`R`\>

###### Type Parameters

###### GraphPorts

`GraphPorts`

###### Meta

`Meta`

###### ND

`ND` _extends_ `Flat`\<\{ \[K in string \| number \| symbol as undefined extends Role\<D\[K\]\> ? never : K\]: RefOf\<Role\<D\[K\]\>\> \} & \{ \[K in string \| number \| symbol as undefined extends Role\<D\[K\]\> ? K : never\]?: RefOf\<NonNullable\<Role\<D\[K\]\>\>\> \}\> = `Flat`\<\{ \[K in string \| number \| symbol as undefined extends Role\<D\[K\]\> ? never : K\]: RefOf\<Role\<D\[K\]\>\> \} & \{ \[K in string \| number \| symbol as undefined extends Role\<D\[K\]\> ? K : never\]?: RefOf\<NonNullable\<Role\<D\[K\]\>\>\> \}\>

###### NI

`NI` = `N`

###### Parameters

###### graph

[`Graph`](#graph)\<`GraphPorts`, `Meta`\>

###### params

[`NodeParams`](#nodeparams)\<`D`, `N`, `I`, `Meta`, `ND`, `NI`\>

###### Returns

[`NodeRef`](#noderef)\<`R`\>

---

### ActionContext

Everything one call of an action gets. What is keyed: `inputs` and `depOutputs`, each file in
them a `FileHandle`. Its tools: `ports`. What the attempt gives: `outputDir`, the absolute path
of a new, empty directory only this attempt writes; `signal`, which fires on the node's timeout
or the execution's cancel; and `output`, for what the action prints, in chunks as printed. `D`
is the deps the action declares, and `I` its inputs and its nodes' together.

#### Type Parameters

##### Ports

`Ports` = `unknown`

##### D

`D` = [`DepSpecs`](#depspecs)

##### I

`I` = `Record`\<`string`, `unknown`\>

#### Properties

##### depOutputs

> **depOutputs**: `DepOutputsOf`\<`D`\>

##### inputs

> **inputs**: `Resolved`\<`I`\>

##### output

> **output**: (`chunk`) => `void`

###### Parameters

###### chunk

`string`

###### Returns

`void`

##### outputDir

> **outputDir**: `string`

##### ports

> **ports**: `Ports`

##### signal

> **signal**: `AbortSignal`

---

### ActionSpec

What `defineAction` takes. Its types come from its fields: the deps by `deps`, the inputs by
`nodeInputs` and `inputs`, and the outputs, `R`, by what `action` returns. Only the kind, the
inputs and the deps' content join a node's key; `deps` and `nodeInputs` declare, and each node
gives.

#### Type Parameters

##### Ports

`Ports`

##### R

`R`

##### D

`D`

##### N

`N` _extends_ [`InputRecord`](#inputrecord)\<`unknown`\>

##### I

`I`

##### Group

`Group` _extends_ `string` = `never`

#### Properties

##### action

> **action**: (`context`) => `Promise`\<`R` & [`Outputs`](#outputs-1)\>

###### Parameters

###### context

`NoInfer`\<[`ActionContext`](#actioncontext)\<`Ports`, `D`, `I` & `N`\>\>

###### Returns

`Promise`\<`R` & [`Outputs`](#outputs-1)\>

##### cacheable?

> `optional` **cacheable?**: `boolean`

`false` runs the node in every execution: its entry is never read or written.

##### concurrencyGroup?

> `optional` **concurrencyGroup?**: `Group`

The group whose limit it runs under, with `throttledScheduler`: one that `actionsFor` names.

##### deps?

> `optional` **deps?**: `D`

The deps each node gives, by role. A role is the action that produces it, `{ fetch }`, or
`dep<T>` when more than one can; `settled` marks one its node runs without, and `maybe` one a
node may leave out, each called around an action, `settled(fetch)`, and uncalled around a
type, `settled<T>`. A record typed `DepSpecs` takes any role.

##### inputs?

> `optional` **inputs?**: `I`

Inputs every node of the action has, such as a version that names the action's logic.

##### invalidateOn?

> `optional` **invalidateOn?**: `NoInfer`\<[`InvalidateOn`](#invalidateon-1)\<`Ports`, `D`\>\>

##### kind

> **kind**: `string`

What kind of work it is, as Bazel's mnemonic. It names the action's logic and joins the key,
so actions of two kinds never share an entry. Nodes of one kind that differ put what differs
in their node inputs.

##### nodeInputs?

> `optional` **nodeInputs?**: [`NodeInputsSpec`](#nodeinputsspec)\<`N`\> \| (() => [`NodeInputsSpec`](#nodeinputsspec)\<`N`\>)

The inputs each node gives when it is added, by name and type, uncalled:
`nodeInputs<{ url: string }>`. `N` is that record type. Each node gives only these names.

##### timeoutMs?

> `optional` **timeoutMs?**: `number`

How long the action may run, in ms, counted from its start. Not keyed.

---

### Cache

Content-addressed cache used by the executor to skip unchanged nodes.

#### Methods

##### get()

> **get**(`key`): `Promise`\<[`CacheEntry`](#cacheentry) \| `undefined`\>

###### Parameters

###### key

`string`

###### Returns

`Promise`\<[`CacheEntry`](#cacheentry) \| `undefined`\>

##### put()

> **put**(`key`, `entry`): `Promise`\<`void`\>

###### Parameters

###### key

`string`

###### entry

[`CacheEntry`](#cacheentry)

###### Returns

`Promise`\<`void`\>

---

### CacheEntry

What gets stored per action key in the cache.

#### Properties

##### contentHash

> **contentHash**: `string`

SHA256 of actual file contents at those paths.

##### outputs

> **outputs**: [`Outputs`](#outputs-1)

The file paths the action produced.

---

### DagFs

Minimal filesystem contract the DAG executor needs. Implementations ship in `ports/fs`. The
engine calls its members detached, as `fs.hashFile`, so none may read `this`.

#### Properties

##### ensureDir

> **ensureDir**: (`path`) => `Promise`\<`void`\>

###### Parameters

###### path

`string`

###### Returns

`Promise`\<`void`\>

##### exists

> **exists**: (`path`) => `Promise`\<`boolean`\>

###### Parameters

###### path

`string`

###### Returns

`Promise`\<`boolean`\>

##### hashFile

> **hashFile**: (`path`) => `Promise`\<`string`\>

The SHA256 hex of a file's content. With no file at `path`, it rejects with an error whose
`code` is `"ENOENT"`, as `node:fs` does: so the engine names an output that was not written.

###### Parameters

###### path

`string`

###### Returns

`Promise`\<`string`\>

##### readdir

> **readdir**: (`dir`) => `Promise`\<`string`[]\>

The names of the entries in a directory; none when the directory does not exist.

###### Parameters

###### dir

`string`

###### Returns

`Promise`\<`string`[]\>

##### readText

> **readText**: (`path`) => `Promise`\<`string`\>

###### Parameters

###### path

`string`

###### Returns

`Promise`\<`string`\>

##### remove

> **remove**: (`path`) => `Promise`\<`void`\>

Removes a file, or a directory and everything in it; nothing when the path does not exist.

###### Parameters

###### path

`string`

###### Returns

`Promise`\<`void`\>

##### rename

> **rename**: (`from`, `to`) => `Promise`\<`void`\>

POSIX `rename`: replaces a file at `to` atomically; fails when `to` is a non-empty directory.

###### Parameters

###### from

`string`

###### to

`string`

###### Returns

`Promise`\<`void`\>

##### resolve

> **resolve**: (`path`) => `string`

The absolute form of `path`, as an action sees it.

###### Parameters

###### path

`string`

###### Returns

`string`

##### writeText

> **writeText**: (`path`, `content`) => `Promise`\<`void`\>

###### Parameters

###### path

`string`

###### content

`string`

###### Returns

`Promise`\<`void`\>

---

### Dep

A dep as an action declares it in `deps`, by role: the outputs its node returns. An action is
one, so `deps: { fetch }` takes a node of `fetch`; `dep<T>` is one for a role that more than one
action fills. A node of the action gives the role a `NodeRef<T>`, never a `Dep`.

#### Type Parameters

##### T

`T` _extends_ [`Outputs`](#outputs-1) = [`Outputs`](#outputs-1)

#### Properties

##### \_T?

> `readonly` `optional` **\_T?**: `T`

##### \[DEP\]

> `readonly` **\[DEP\]**: `true`

##### settled?

> `readonly` `optional` **settled?**: `false`

---

### ExecuteOptions

The options of one execution. The execution context outlives it.

#### Type Parameters

##### Meta

`Meta` = `unknown`

#### Properties

##### onEvent?

> `optional` **onEvent?**: [`ExecListener`](#execlistener)\<`Meta`\>

##### scheduler?

> `optional` **scheduler?**: [`Scheduler`](#scheduler-1)

##### signal?

> `optional` **signal?**: `AbortSignal`

Cancels the execution: nodes still waiting settle `cancelled` and nothing new starts. A
running node gets the signal through its action context and settles `cancelled` whatever its
action returns. The returned results are complete either way.

---

### Node

A node as data, from `graph.describe()`: no action, inputs or fingerprints, so it can cross
into orchestration and into another process when its `meta` can.

#### Type Parameters

##### Meta

`Meta` = `unknown`

#### Properties

##### cacheable?

> `optional` **cacheable?**: `boolean`

`false`: the node's entry is never read or written, so it runs in every execution.

##### concurrencyGroup?

> `optional` **concurrencyGroup?**: `string`

##### deps

> **deps**: `string`[]

The names of the nodes it depends on, once each.

##### kind

> **kind**: `string`

##### meta?

> `optional` **meta?**: `Meta`

##### name

> **name**: `string`

##### settledDeps?

> `optional` **settledDeps?**: `string`[]

The deps it runs without when they do not succeed.

##### timeoutMs?

> `optional` **timeoutMs?**: `number`

How long the action may run, in ms, before its signal fires with a "TimeoutError".

---

### NodeInputsSpec

The inputs that each node of an action gives when it is added, by name and type, as its
`nodeInputs` declares them. `T` is a record type, never an interface, which has no index
signature.

#### Type Parameters

##### T

`T` _extends_ [`InputRecord`](#inputrecord)\<`unknown`\> = [`InputRecord`](#inputrecord)\<`unknown`\>

#### Properties

##### \_T?

> `readonly` `optional` **\_T?**: `T`

##### \[NODE_INPUTS\]

> `readonly` **\[NODE_INPUTS\]**: `true`

---

### Ready

A node the scheduler may take: ready to be processed, or a miss waiting for its group's slot.

#### Type Parameters

##### Meta

`Meta` = `unknown`

#### Properties

##### node

> **node**: [`Node`](#node)\<`Meta`\>

##### waitingForSlot

> **waitingForSlot**: `boolean`

---

### RunActionOptions

#### Type Parameters

##### Meta

`Meta`

#### Properties

##### onEvent?

> `optional` **onEvent?**: [`ExecListener`](#execlistener)\<`Meta`\>

Receives the node's `start` and `output`, before its result returns.

##### signal?

> `optional` **signal?**: `AbortSignal`

The execution's cancel. A node it stops settles `cancelled`, whatever its action returns.

---

### SchedulerContext

What a scheduler drives. `take` returns the first ready node, in orchestration's order, that
`filter` admits: a node comes once when it is ready and, when its lookup misses and it has a
concurrency group, again with `waitingForSlot` set. `run` hands a ready node to processing, or
grants a waiting one its slot; it resolves once the node settles or, waiting for a slot, gives
its place back. `workAvailable` resolves when that may have changed what `take` returns.

#### Type Parameters

##### Meta

`Meta` = `unknown`

#### Methods

##### hasWork()

> **hasWork**(): `boolean`

###### Returns

`boolean`

##### run()

> **run**(`ready`): `Promise`\<`void`\>

###### Parameters

###### ready

[`Ready`](#ready)\<`Meta`\>

###### Returns

`Promise`\<`void`\>

##### take()

> **take**(`filter?`): [`Ready`](#ready)\<`Meta`\> \| `null`

###### Parameters

###### filter?

(`ready`) => `boolean`

###### Returns

[`Ready`](#ready)\<`Meta`\> \| `null`

##### workAvailable()

> **workAvailable**(): `Promise`\<`void`\>

###### Returns

`Promise`\<`void`\>

---

### SettledDep

A dep declared `settled`, which its node runs without: a node gives it a `SettledRef<T>`.

#### Type Parameters

##### T

`T` _extends_ [`Outputs`](#outputs-1) = [`Outputs`](#outputs-1)

#### Properties

##### \_T?

> `readonly` `optional` **\_T?**: `T`

##### \[DEP\]

> `readonly` **\[DEP\]**: `true`

##### settled

> `readonly` **settled**: `true`

---

### ThrottledSchedulerOptions

#### Properties

##### concurrencyLimits?

> `optional` **concurrencyLimits?**: `Record`\<`string`, `number`\>

For each concurrency group, the most of its actions that run at once; a hit takes no slot.

##### maxParallelism?

> `optional` **maxParallelism?**: `number`

The most nodes processed at once, as Ninja's `-j`.

## Type Aliases

### DepRecord

> **DepRecord** = `Record`\<`string`, [`NodeRef`](#noderef) \| [`SettledRef`](#settledref) \| `undefined`\>

The deps a node may give, by role.

---

### DepRefs

> **DepRefs**\<`D`, `S`\> = `{ readonly [K in keyof D]: RefsOf<D[K], S> }`

What a node's `inputs` function receives: each dep it declares, by role, as a ref to each of
the dep's outputs, an `OutputRef` for a required dep and a `SettledOutputRef` for a `settled`
one. The refs of a dep cannot be listed, as by a spread, since its outputs' names exist only in
the types: name each one, `pack.tarball`. An output that some return of the dep leaves out, or
that an index signature names, has no ref: the action reads it from `depOutputs`, where it is
`| undefined`.

#### Type Parameters

##### D

`D`

##### S

`S`

---

### DepSpecs

> **DepSpecs** = `object`

The deps an action declares, by role: each a `DepSpec`, or a function that returns one, as an
uncalled `dep<T>` is. A record of this type takes a dep in any role: `const anyRole: DepSpecs =
{}`, `deps: anyRole`.

#### Index Signature

\[`role`: `string`\]: `DepSpec` \| (() => `DepSpec`)

---

### DepSpecsOf

> **DepSpecsOf**\<`D`\> = `{ [K in keyof D]: DepOf<D[K]> }`

The deps an action declares for the deps `D` a node gives, `NodeDeps` the other way: a `Dep` for
each `NodeRef`, a `SettledDep` for each `SettledRef`, and `maybe` for a role that may be
`undefined`. For an action defined for one node, which declares the deps that node gives.

#### Type Parameters

##### D

`D` _extends_ [`DepRecord`](#deprecord)

---

### ExecEvent

> **ExecEvent**\<`Meta`\> = `object` & (\{ `type`: `"dispatch"`; \} \| \{ `type`: `"start"`; \} \| \{ `chunk`: `string`; `type`: `"output"`; \} \| \{ `result`: [`Result`](#result); `type`: `"result"`; \})

One stream of what happens, each event naming its node and carrying its `meta`. Orchestration
emits `dispatch`, as a node is handed to processing, and `result`. Processing emits `start`, on
a miss as the action begins, and `output`, for what the action prints.

#### Type Parameters

##### Meta

`Meta` = `unknown`

#### Type Declaration

##### meta?

> `optional` **meta?**: `Meta`

##### node

> **node**: `string`

---

### ExecListener

> **ExecListener**\<`Meta`\> = (`event`) => `unknown`

Receives each `ExecEvent`. For `start` it may return a promise, and the action runs only once it
resolves, so a journal records the start before any effect: `onEvent: (event) =>
journal.record(event)`. A rejection fails the node without running it. The promise of an `output`
is not awaited, and its rejection is dropped. That of a `dispatch` or a `result` that rejects
before the execution ends rejects it at its end, as a throw does.

#### Type Parameters

##### Meta

`Meta` = `unknown`

#### Parameters

##### event

[`ExecEvent`](#execevent)\<`Meta`\>

#### Returns

`unknown`

---

### ExecutionContext

> **ExecutionContext**\<`Ports`\> = `object` & (`unknown` _extends_ `Ports` ? `object` : `object`)

What an executor hands the engine. It outlives any one execution. `ports` are the actions'
tools, which the engine passes through; a graph whose actions need none takes no `ports`.

#### Type Parameters

##### Ports

`Ports` = `unknown`

#### Type Declaration

##### cache

> **cache**: [`Cache`](#cache)

##### casBaseDir

> **casBaseDir**: `string`

##### fs

> **fs**: [`DagFs`](#dagfs)

---

### FailedError

> **FailedError** = `Extract`\<[`Result`](#result), \{ `status`: `"failed"`; \}\>\[`"error"`\]

The error of a `failed` result.

---

### FileHandle

> **FileHandle** = `object` & [`NotAString`](#notastring)

A file an action reads: a `file()` input, or an output of a dep. Where it lives is the engine's.

- Hand a tool its path: `ports.images.resize(depOutputs.source.path, out)`.
- Read it with `text()`, or with `json(isMeta)`, where `isMeta` is a type guard.
- It is never part of a string: TypeScript refuses it in a template string or with `+`, and
  `String` and `JSON.stringify` throw. A string takes its `path`: `` `--input=${source.path}` ``.
- Tell a handle apart with `isFileHandle`, never with `typeof`: its type is a symbol's, but it
  is an object.

#### Type Declaration

##### \[FILE_HANDLE\]

> `readonly` **\[FILE_HANDLE\]**: `true`

##### path

> `readonly` **path**: `string`

Its absolute path while the action runs, for a command or a library that takes a path. It
differs by machine and working directory, so never key on it: build no fingerprint and no
output's content from it.

##### hash()

> **hash**(): `Promise`\<`string`\>

The SHA256 of its bytes, as the engine hashes outputs: the fingerprint of a binary file.

###### Returns

`Promise`\<`string`\>

##### json()

> **json**\<`T`\>(`is`): `Promise`\<`T`\>

Its contents as JSON, checked by `is`; a file `is` refuses throws, naming the file.

###### Type Parameters

###### T

`T`

###### Parameters

###### is

(`value`) => `value is T`

###### Returns

`Promise`\<`T`\>

##### text()

> **text**(): `Promise`\<`string`\>

Its contents.

###### Returns

`Promise`\<`string`\>

---

### FileInput

> **FileInput** = `object` & [`NotAString`](#notastring)

A file input: its path, as given, and its content's hash join the key.

#### Type Declaration

##### \[FILE_INPUT\]

> `readonly` **\[FILE_INPUT\]**: `string`

---

### Handles

> **Handles**\<`T`\> = `{ [K in keyof T]: PathHandles<T[K]> }`

Outputs as an action reads them: each path a `FileHandle`, each list of paths a list of them.

#### Type Parameters

##### T

`T` _extends_ [`Outputs`](#outputs-1)

---

### InputRecord

> **InputRecord**\<`S`\> = `object`

Inputs by name, as an action and a node declare them: each a `file(path)`, only ever a whole
input, or an `InputValue`. `S` is the scope of the `inputs` function whose refs it holds. The
default, `never`, holds no refs: an action's inputs and a node's record of inputs name no output.

#### Type Parameters

##### S

`S` = `never`

#### Index Signature

\[`name`: `string`\]: [`FileInput`](#fileinput) \| [`InputValue`](#inputvalue)\<`S`\> \| `undefined`

---

### InputValue

> **InputValue**\<`S`\> = `string` \| `number` \| `boolean` \| `null` \| readonly [`InputValue`](#inputvalue)\<`S`\>[] \| \{\[`key`: `string`\]: [`InputValue`](#inputvalue)\<`S`\> \| `undefined`; \} \| [`OutputRef`](#outputref)\<`string` \| `string`[], `S`\> \| [`SettledOutputRef`](#settledoutputref)\<`string` \| `string`[], `S`\>

A value input: a string, a finite number, a boolean, `null`, or an array or a plain record of
these. A node's `inputs` function may also put in it the refs it received, of scope `S`. The key
holds the value as JSON with sorted keys, and each ref as the role it points through and its
output's name. A property that is `undefined` is dropped.

These do not compile. Each has a right form:

- A `Map` or a `Set`: `Object.fromEntries(map)`, `[...set]`.
- A `Date`: `date.toISOString()`.
- A `bigint`: `String(n)`.
- A function or a class instance: the data it holds, as a record.
- `undefined` as an array item: `null`, or no item.
- A `file()` in a value: a file is an input of its own, `inputs: { lock: file("bun.lock") }`.
- A node: a dep, declared in `deps`, whose output the `inputs` function names:
  `deps: { pack }, inputs: ({ pack }) => ({ argv: ["npm", "publish", pack.tarball] })`.
- A ref that the function did not receive, such as one kept from another node's function: a
  ref goes only in what the call that received it returns.

No type sees these, so `defineAction` and `addNode` refuse them by their path, as
`inputs.ratio is NaN`: `NaN`, `Infinity`, and an object that is not plain, such as a class
instance typed as a record. A narrower type can also hide a value, as a record typed
`{ model: string }` can hold a function. Both refuse such a value: a function, a symbol, a
bigint, and `undefined` in a list.

#### Type Parameters

##### S

`S` = `never`

---

### InvalidateOn

> **InvalidateOn**\<`Ports`, `D`\> = \{ \[K in keyof D\]?: (outputs: NonNullable\<DepOutputsOf\<D\>\[K\]\>, ports: Ports) =\> Promise\<string\> \| string \}

For a dep its nodes read only in part, that part as a fingerprint by role. The string's hash
stands in for the dep's content hash in the key. Build it from the files' contents, never from a
handle's `path`, which differs by machine and working directory.

#### Type Parameters

##### Ports

`Ports`

##### D

`D`

---

### JsonValue

> **JsonValue** = `string` \| `number` \| `boolean` \| `null` \| readonly [`JsonValue`](#jsonvalue)[] \| \{\[`key`: `string`\]: [`JsonValue`](#jsonvalue) \| `undefined`; \}

A value as JSON holds it. A property that is `undefined` is left out when it is written.

---

### Lookup

> **Lookup** = `Extract`\<[`Result`](#result), \{ `status`: `"cached"` \| `"failed"` \| `"dep-failed"`; \}\> \| [`Miss`](#miss)

How a node's lookup ended: settled without running, or a miss to run.

---

### MemoryDagFs

> **MemoryDagFs** = [`DagFs`](#dagfs) & `object`

#### Type Declaration

##### files

> **files**: `Map`\<`string`, `string` \| `Uint8Array`\>

---

### Miss

> **Miss** = `object`

A node whose key has no verified entry: what `runAction` runs.

#### Properties

##### actionKey

> **actionKey**: `string`

##### name

> **name**: `string`

##### status

> **status**: `"missed"`

---

### NodeParams

> **NodeParams**\<`D`, `N`, `I`, `Meta`, `ND`, `NI`\> = `object` & `DepsParam`\<`D`, `ND`\> & `Param`\<`"inputs"`, `N`, `NodeInputs`\<`N`, `I`, `RefDeps`\<`D`, `ND`\>, `NI`\>\>

What `addNode` takes: a name, deps, inputs and meta, and nothing else. The deps are the roles
the action's `deps` declare (`D`), and its inputs those its `nodeInputs` declare (`N`), with
none of its own `inputs` (`I`). `ND` and `NI`, inferred from the node, are the deps and the
inputs it gives.

#### Type Parameters

##### D

`D`

##### N

`N`

##### I

`I`

##### Meta

`Meta`

##### ND

`ND` = `NodeDeps`\<`D`\>

##### NI

`NI` = `N`

#### Type Declaration

##### meta?

> `optional` **meta?**: `Meta`

##### name?

> `optional` **name?**: `string`

---

### NodeRef

> **NodeRef**\<`T`\> = `object` & [`NotAString`](#notastring)

Handle to a node, returned by `addNode`. `T` is its action's output type.

#### Type Parameters

##### T

`T` _extends_ [`Outputs`](#outputs-1) = [`Outputs`](#outputs-1)

#### Type Declaration

##### \_T?

> `readonly` `optional` **\_T?**: `T`

##### name

> `readonly` **name**: `string`

##### settled?

> `readonly` `optional` **settled?**: `false`

---

### NodeRefOf

> **NodeRefOf**\<`T`\> = [`NodeRef`](#noderef)\<[`OutputOf`](#outputof)\<`T`\>\>

A ref to a node of an action: `NodeRefOf<typeof fetch>`.

#### Type Parameters

##### T

`T`

---

### NotAString

> **NotAString** = `object` & `symbol`

A value that is never part of a string. It is typed as a symbol, which TypeScript refuses in a
template string, with `+`, and where a string goes.

#### Type Declaration

##### toString

> **toString**: `never`

##### valueOf

> **valueOf**: `never`

---

### OutputOf

> **OutputOf**\<`T`\> = `T` _extends_ `object` ? `R` : `never`

The outputs of an action, a ref or a dep: `OutputOf<typeof fetch>`.

#### Type Parameters

##### T

`T`

---

### OutputRef

> **OutputRef**\<`T`, `S`\> = `object` & [`NotAString`](#notastring)

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

### Outputs

> **Outputs** = `Record`\<`string`, `string` \| `string`[]\>

What an action returns: named outputs, each a path or a list of paths under its outputDir.

---

### Result

> **Result** = `object` & ([`CacheEntry`](#cacheentry) & `object` \| [`CacheEntry`](#cacheentry) & `object` \| \{ `elapsed`: `number`; `error`: \{ `cause?`: [`JsonValue`](#jsonvalue); `message`: `string`; `name`: `string`; \}; `status`: `"failed"`; \} \| \{ `dep`: `string`; `status`: `"dep-failed"`; \} \| \{ `status`: `"cancelled"`; \})

How one node settled. `actionKey` is "" when it never got one. A result is plain data, to write
to a file or send to another process as it is. The engine copies a failure's cause when it is
JSON. It changes an `Error` to its name, message and cause, converted the same way. It drops
anything else.

#### Type Declaration

##### actionKey

> **actionKey**: `string`

##### name

> **name**: `string`

---

### RunNode

> **RunNode**\<`Meta`\> = (`node`, `depEntries`, `waitForSlot`) => `Promise`\<[`Result`](#result)\>

Processes one node somewhere, given its deps' entries by dep name, and returns its result. On
a miss it awaits `waitForSlot` before the action runs, which resolves once the scheduler grants
the node's group a slot, and rejects once the execution is cancelled. A rejection of
`RunNode` becomes a failure, as an action's error does, or `cancelled` once the execution is
cancelled.

#### Type Parameters

##### Meta

`Meta` = `unknown`

#### Parameters

##### node

[`Node`](#node)\<`Meta`\>

##### depEntries

`Record`\<`string`, [`CacheEntry`](#cacheentry)\>

##### waitForSlot

() => `Promise`\<`void`\>

#### Returns

`Promise`\<[`Result`](#result)\>

---

### Scheduler

> **Scheduler** = \<`Meta`\>(`ctx`) => `Promise`\<`void`\>

The policy that admits ready nodes. It takes them in orchestration's order and only filters
it: it may hold a node back, but never reorders them.

#### Type Parameters

##### Meta

`Meta`

#### Parameters

##### ctx

[`SchedulerContext`](#schedulercontext)\<`Meta`\>

#### Returns

`Promise`\<`void`\>

---

### SettledOutputRef

> **SettledOutputRef**\<`T`, `S`\> = `object` & [`NotAString`](#notastring)

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

> **SettledRef**\<`T`\> = `object` & [`NotAString`](#notastring)

A dep its node runs without when it does not succeed, as `Promise.allSettled` waits.

#### Type Parameters

##### T

`T` _extends_ [`Outputs`](#outputs-1) = [`Outputs`](#outputs-1)

#### Type Declaration

##### \_T?

> `readonly` `optional` **\_T?**: `T`

##### name

> `readonly` **name**: `string`

##### settled

> `readonly` **settled**: `true`

---

### SucceededResult

> **SucceededResult** = `Extract`\<[`Result`](#result), \{ `status`: `"done"` \| `"cached"`; \}\>

The result of a node that succeeded, `done` or `cached`: it carries the node's entry.

---

### Tally

> **Tally** = `Record`\<[`Result`](#result)\[`"status"`\], `number`\>

## Variables

### defineAction

> `const` **defineAction**: \<`R`, `D`, `N`, `I`\>(`spec`) => [`Action`](#action)\<`unknown`, `Extract`\<`R`, [`Outputs`](#outputs-1)\>, `D`, `N`, `I`\>

An action that needs no ports. A program with ports binds its own: `actionsFor<Ports>()`.

#### Type Parameters

##### R

`R`

##### D

`D` _extends_ [`DepSpecs`](#depspecs) = `Empty`

##### N

`N` _extends_ [`InputRecord`](#inputrecord)\<`unknown`\> = `Empty`

##### I

`I` _extends_ [`InputRecord`](#inputrecord) = `Empty`

#### Parameters

##### spec

[`ActionSpec`](#actionspec)\<`unknown`, `R`, `D`, `N`, `I`, `never`\>

#### Returns

[`Action`](#action)\<`unknown`, `Extract`\<`R`, [`Outputs`](#outputs-1)\>, `D`, `N`, `I`\>

## Functions

### actionsFor()

> **actionsFor**\<`Ports`, `Group`\>(): \<`R`, `D`, `N`, `I`\>(`spec`) => [`Action`](#action)\<`Ports`, `Extract`\<`R`, [`Outputs`](#outputs-1)\>, `D`, `N`, `I`\>

`defineAction` bound to a program's ports, the one type it cannot infer: bind it once,
`const defineActionWithPorts = actionsFor<Ports>()`, and every other type comes from each spec.
An action may join only a group the program names, `actionsFor<Ports, keyof typeof limits>()`
over its `throttledScheduler`'s `concurrencyLimits`, so a misspelt group does not compile.
An action's outputs are what it returns, a path as `string`, a list as `string[]`.

#### Type Parameters

##### Ports

`Ports`

##### Group

`Group` _extends_ `string` = `never`

#### Returns

\<`R`, `D`, `N`, `I`\>(`spec`) => [`Action`](#action)\<`Ports`, `Extract`\<`R`, [`Outputs`](#outputs-1)\>, `D`, `N`, `I`\>

---

### closure()

> **closure**\<`Ports`, `Meta`\>(`graph`, `names`): [`Graph`](#graph)\<`Ports`, `Meta`\>

The graph of the named nodes and every node they depend on, `settled` deps included, each as
it is, in the order they were added. Executing it runs part of a graph against the same entries.

#### Type Parameters

##### Ports

`Ports`

##### Meta

`Meta`

#### Parameters

##### graph

[`Graph`](#graph)\<`Ports`, `Meta`\>

##### names

`Iterable`\<`string`, `any`, `any`\> & `object`

#### Returns

[`Graph`](#graph)\<`Ports`, `Meta`\>

---

### createMemoryDagFs()

> **createMemoryDagFs**(`initial?`): [`MemoryDagFs`](#memorydagfs)

In-memory DagFs for tests. `files` is exposed so a test can inspect or seed it directly. A
directory is the files under its path, so an empty one does not exist. A path is its own
absolute form: `resolve` returns it as given.

#### Parameters

##### initial?

`Record`\<`string`, `string` \| `Uint8Array`\<`ArrayBufferLike`\>\>

#### Returns

[`MemoryDagFs`](#memorydagfs)

---

### dep()

> **dep**\<`T`\>(): [`Dep`](#dep-1)\<`T`\>

A role that more than one action fills, by the outputs its nodes return. It names only a type,
so it goes uncalled: `deps: { image: dep<{ image: string }> }`. Where one action fills the role,
name that action: `deps: { fetch }`.

#### Type Parameters

##### T

`T` _extends_ [`Outputs`](#outputs-1)

#### Returns

[`Dep`](#dep-1)\<`T`\>

---

### execute()

> **execute**\<`Ports`, `Meta`\>(`graph`, `executionContext`, `options?`): `Promise`\<[`Result`](#result)[]\>

Run a graph in one process: orchestration, and each node processed in the same process with
the same graph and `onEvent`. Returns one result per node, in the order they settled.

#### Type Parameters

##### Ports

`Ports`

##### Meta

`Meta`

#### Parameters

##### graph

[`Graph`](#graph)\<`Ports`, `Meta`\>

##### executionContext

[`ExecutionContext`](#executioncontext)\<`NoInfer`\<`Ports`\>\>

##### options?

[`ExecuteOptions`](#executeoptions)\<`Meta`\> = `{}`

#### Returns

`Promise`\<[`Result`](#result)[]\>

---

### file()

> **file**(`path`): [`FileInput`](#fileinput)

A file input, read by the action as a handle on the file.

#### Parameters

##### path

`string`

#### Returns

[`FileInput`](#fileinput)

---

### forcedCache()

> **forcedCache**(`cache`, `keys?`): [`Cache`](#cache)

`cache` with every read of `keys` a miss, or of every key without them: the nodes of those keys
run again and write their new entries, which later reads hit. This is how to force nodes.

#### Parameters

##### cache

[`Cache`](#cache)

##### keys?

`ReadonlySet`\<`string`\>

#### Returns

[`Cache`](#cache)

---

### isFileHandle()

> **isFileHandle**(`value`): `value is FileHandle`

Whether a value is a handle: a list or a record of handles is not.

#### Parameters

##### value

`unknown`

#### Returns

`value is FileHandle`

---

### isResult()

> **isResult**(`value`): `value is Result`

Whether `value` is a `Result`: the guard for one read back from a file or another process.

#### Parameters

##### value

`unknown`

#### Returns

`value is Result`

---

### isSucceeded()

> **isSucceeded**(`result`): `result is SucceededResult`

Whether the node succeeded: its result is `done` or `cached`.

#### Parameters

##### result

[`Result`](#result)

#### Returns

`result is SucceededResult`

---

### localRunNode()

> **localRunNode**\<`Ports`, `Meta`\>(`graph`, `executionContext`, `options?`): [`RunNode`](#runnode)\<`Meta`\>

The `RunNode` that `execute` uses: each node of `graph` processed in this process, its lookup
first and, on a miss, its action once it has its slot. A cancel while it waits settles it
`cancelled`.

#### Type Parameters

##### Ports

`Ports`

##### Meta

`Meta`

#### Parameters

##### graph

[`Graph`](#graph)\<`Ports`, `Meta`\>

##### executionContext

[`ExecutionContext`](#executioncontext)\<`NoInfer`\<`Ports`\>\>

##### options?

[`RunActionOptions`](#runactionoptions)\<`Meta`\> = `{}`

#### Returns

[`RunNode`](#runnode)\<`Meta`\>

---

### lookupNode()

> **lookupNode**\<`Ports`, `Meta`\>(`graph`, `name`, `depEntries`, `executionContext`): `Promise`\<[`Lookup`](#lookup)\>

Look the node `name` of `graph` up: compute its key, then read and verify its entry. It settles
`cached`, `dep-failed` or `failed` without running, or is a miss. `depEntries`, by dep node
name, holds the entry of each dep that succeeded.

#### Type Parameters

##### Ports

`Ports`

##### Meta

`Meta`

#### Parameters

##### graph

[`Graph`](#graph)\<`Ports`, `Meta`\>

##### name

`string`

##### depEntries

`Record`\<`string`, [`CacheEntry`](#cacheentry)\>

##### executionContext

[`ExecutionContext`](#executioncontext)\<`NoInfer`\<`Ports`\>\>

#### Returns

`Promise`\<[`Lookup`](#lookup)\>

---

### maybe()

#### Call Signature

> **maybe**\<`T`\>(`dep`): [`SettledDep`](#settleddep)\<`T`\> \| `undefined`

Mark a role that a node may leave out: around the action that fills it, `deps: { summary:
maybe(summarize) }`, or uncalled, by its outputs, `deps: { summary: maybe<{ text: string }> }`.
Its outputs are `undefined` when the node gives no dep, so the action checks before it reads
them.

##### Type Parameters

###### T

`T` _extends_ [`Outputs`](#outputs-1)

##### Parameters

###### dep

[`SettledDep`](#settleddep)\<`T`\>

##### Returns

[`SettledDep`](#settleddep)\<`T`\> \| `undefined`

#### Call Signature

> **maybe**\<`T`\>(`dep`): [`Dep`](#dep-1)\<`T`\> \| `undefined`

Mark a role that a node may leave out: around the action that fills it, `deps: { summary:
maybe(summarize) }`, or uncalled, by its outputs, `deps: { summary: maybe<{ text: string }> }`.
Its outputs are `undefined` when the node gives no dep, so the action checks before it reads
them.

##### Type Parameters

###### T

`T` _extends_ [`Outputs`](#outputs-1)

##### Parameters

###### dep

[`Dep`](#dep-1)\<`T`\>

##### Returns

[`Dep`](#dep-1)\<`T`\> \| `undefined`

#### Call Signature

> **maybe**\<`T`\>(): [`Dep`](#dep-1)\<`T`\> \| `undefined`

Mark a role that a node may leave out: around the action that fills it, `deps: { summary:
maybe(summarize) }`, or uncalled, by its outputs, `deps: { summary: maybe<{ text: string }> }`.
Its outputs are `undefined` when the node gives no dep, so the action checks before it reads
them.

##### Type Parameters

###### T

`T` _extends_ [`Outputs`](#outputs-1)

##### Returns

[`Dep`](#dep-1)\<`T`\> \| `undefined`

---

### namedOutput()

> **namedOutput**(`outputs`, `name`): `string`

The path a node's outputs hold as `name`; refused when they hold none.

#### Parameters

##### outputs

[`Outputs`](#outputs-1)

##### name

`string`

#### Returns

`string`

---

### nodeInputs()

> **nodeInputs**\<`T`\>(): [`NodeInputsSpec`](#nodeinputsspec)\<`T`\>

Declare the inputs each node gives, by name and type. It names only a type, so it goes
uncalled: `nodeInputs: nodeInputs<{ url: string; lock: FileInput }>`. The action reads them
beside its own `inputs`.

#### Type Parameters

##### T

`T` _extends_ [`InputRecord`](#inputrecord)\<`unknown`\>

#### Returns

[`NodeInputsSpec`](#nodeinputsspec)\<`T`\>

---

### nodeRefNamed()

> **nodeRefNamed**(`name`): [`NodeRef`](#noderef)

A ref to the node named `name`, its outputs untyped, for a dep on a node known by name alone.

#### Parameters

##### name

`string`

#### Returns

[`NodeRef`](#noderef)

---

### notAString()

> **notAString**\<`T`\>(`value`, `refusal`): `T` & `object` & `symbol`

`value` itself, made a value that is never part of a string: each conversion to a string throws
`refusal`, and its type is NotAString, so TypeScript refuses it in a template string or with `+`.

#### Type Parameters

##### T

`T` _extends_ `object`

#### Parameters

##### value

`T`

##### refusal

`string`

#### Returns

`T` & `object` & `symbol`

---

### orchestrate()

> **orchestrate**\<`Meta`\>(`nodes`, `run`, `schedule`, `onEvent?`, `signal?`): `Promise`\<[`Result`](#result)[]\>

The scheduling half of `execute`, for an executor that processes nodes elsewhere. It works on
nodes as data: it tracks which are ready, admits them through the scheduler, hands each its
deps' entries, and propagates a failure. It does no I/O, hashes nothing and never sees an
action, so it runs in a sandbox such as Temporal's workflow.

A throw of `onEvent` stops nothing: once the nodes settle, `orchestrate` rejects with the first
error that it threw.

#### Type Parameters

##### Meta

`Meta`

#### Parameters

##### nodes

`Iterable`\<[`Node`](#node)\<`Meta`\>\>

##### run

[`RunNode`](#runnode)\<`Meta`\>

##### schedule

[`Scheduler`](#scheduler-1)

##### onEvent?

[`ExecListener`](#execlistener)\<`Meta`\>

##### signal?

`AbortSignal`

#### Returns

`Promise`\<[`Result`](#result)[]\>

---

### processNode()

> **processNode**\<`Ports`, `Meta`\>(`graph`, `name`, `depEntries`, `executionContext`, `options?`): `Promise`\<[`Result`](#result)\>

Process the node `name` of `graph` now, with no slot to wait for: look it up, and run its action
on a miss. For a test, a script, or a worker whose orchestrator took the node's slot already.

#### Type Parameters

##### Ports

`Ports`

##### Meta

`Meta`

#### Parameters

##### graph

[`Graph`](#graph)\<`Ports`, `Meta`\>

##### name

`string`

##### depEntries

`Record`\<`string`, [`CacheEntry`](#cacheentry)\>

##### executionContext

[`ExecutionContext`](#executioncontext)\<`NoInfer`\<`Ports`\>\>

##### options?

[`RunActionOptions`](#runactionoptions)\<`Meta`\> = `{}`

#### Returns

`Promise`\<[`Result`](#result)\>

---

### requiredDeps()

> **requiredDeps**(`node`): `string`[]

The deps a node runs only once they succeed: its deps less its `settled` ones.

#### Parameters

##### node

[`Node`](#node)

#### Returns

`string`[]

---

### runAction()

> **runAction**\<`Ports`, `Meta`\>(`graph`, `__namedParameters`, `depEntries`, `executionContext`, `options?`): `Promise`\<[`Result`](#result)\>

Run the action of a node that missed, store what it made, and write its entry. `depEntries` are
the ones its lookup was given.

#### Type Parameters

##### Ports

`Ports`

##### Meta

`Meta`

#### Parameters

##### graph

[`Graph`](#graph)\<`Ports`, `Meta`\>

##### \_\_namedParameters

[`Miss`](#miss)

##### depEntries

`Record`\<`string`, [`CacheEntry`](#cacheentry)\>

##### executionContext

[`ExecutionContext`](#executioncontext)\<`NoInfer`\<`Ports`\>\>

##### options?

[`RunActionOptions`](#runactionoptions)\<`Meta`\> = `{}`

#### Returns

`Promise`\<[`Result`](#result)\>

---

### settled()

#### Call Signature

> **settled**\<`T`\>(`ref`): [`SettledRef`](#settledref)\<`T`\>

Mark a dep its node runs without: when it does not succeed, its role is `undefined`. An action
declares the role with it, around the action that fills it, `deps: { captions:
settled(captions) }`, or uncalled, by the outputs of a role more than one action fills, `deps:
{ captions: settled<{ srt: string }> }`. Its node marks the ref it gives, `deps: { captions:
settled(captionsRef) }`: a role declared one way takes no ref of the other.

##### Type Parameters

###### T

`T` _extends_ [`Outputs`](#outputs-1)

##### Parameters

###### ref

[`NodeRef`](#noderef)\<`T`\>

##### Returns

[`SettledRef`](#settledref)\<`T`\>

#### Call Signature

> **settled**\<`T`\>(`dep`): [`SettledDep`](#settleddep)\<`T`\>

Mark a dep its node runs without: when it does not succeed, its role is `undefined`. An action
declares the role with it, around the action that fills it, `deps: { captions:
settled(captions) }`, or uncalled, by the outputs of a role more than one action fills, `deps:
{ captions: settled<{ srt: string }> }`. Its node marks the ref it gives, `deps: { captions:
settled(captionsRef) }`: a role declared one way takes no ref of the other.

##### Type Parameters

###### T

`T` _extends_ [`Outputs`](#outputs-1)

##### Parameters

###### dep

[`Dep`](#dep-1)\<`T`\>

##### Returns

[`SettledDep`](#settleddep)\<`T`\>

#### Call Signature

> **settled**\<`T`\>(): [`SettledDep`](#settleddep)\<`T`\>

Mark a dep its node runs without: when it does not succeed, its role is `undefined`. An action
declares the role with it, around the action that fills it, `deps: { captions:
settled(captions) }`, or uncalled, by the outputs of a role more than one action fills, `deps:
{ captions: settled<{ srt: string }> }`. Its node marks the ref it gives, `deps: { captions:
settled(captionsRef) }`: a role declared one way takes no ref of the other.

##### Type Parameters

###### T

`T` _extends_ [`Outputs`](#outputs-1)

##### Returns

[`SettledDep`](#settleddep)\<`T`\>

---

### tally()

> **tally**(`results`): [`Tally`](#tally)

Count results by status.

#### Parameters

##### results

`Iterable`\<[`Result`](#result)\>

#### Returns

[`Tally`](#tally)

---

### throttledScheduler()

> **throttledScheduler**(`opts?`): [`Scheduler`](#scheduler-1)

Scheduler with a global limit and one per concurrency group, as Ninja's pools. A node holds its
place from being handed to processing until it settles. A miss in a group gives its place back
while it waits for the group's slot, and takes both once both are free.

#### Parameters

##### opts?

[`ThrottledSchedulerOptions`](#throttledscheduleroptions)

#### Returns

[`Scheduler`](#scheduler-1)

---

### unboundedScheduler()

> **unboundedScheduler**(): [`Scheduler`](#scheduler-1)

Scheduler with no limits: admits every ready node at once. This is the default.

#### Returns

[`Scheduler`](#scheduler-1)
