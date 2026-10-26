[**@mrmeku/dagworkflows**](../../README.md)

---

[@mrmeku/dagworkflows](../../README.md) / [index](../README.md) / selectors

# selectors

## Functions

### actionKeyOf()

> **actionKeyOf**(`nodeState`): `string` \| `undefined`

"" for a node cancelled before it had one, none for a skipped or unsettled one.

#### Parameters

##### nodeState

[`NodeState`](../README.md#nodestate)

#### Returns

`string` \| `undefined`

---

### causesOf()

> **causesOf**(`run`, `nodeState`): `string`[]

The own failures a consequence goes back to, through the failed nodes between.

#### Parameters

##### run

[`RunState`](../README.md#runstate)

##### nodeState

[`NodeState`](../README.md#nodestate)

#### Returns

`string`[]

---

### consequencesOf()

> **consequencesOf**(`run`, `ownFailureName`): `object`

#### Parameters

##### run

[`RunState`](../README.md#runstate)

##### ownFailureName

`string`

#### Returns

`object`

##### failed

> **failed**: `string`[]

##### skipped

> **skipped**: `string`[]

---

### durationOf()

#### Call Signature

> **durationOf**(`nodeState`): `number`

From its action's start (a cache hit's dispatch) to its settle, at least 1 ms: always, for a node that ran to its end.

##### Parameters

###### nodeState

[`SucceededNodeState`](../README.md#succeedednodestate) \| [`FailedNodeState`](../README.md#failednodestate)

##### Returns

`number`

#### Call Signature

> **durationOf**(`nodeState`): `number` \| `undefined`

From its action's start (a cache hit's dispatch) to its settle, at least 1 ms: always, for a node that ran to its end.

##### Parameters

###### nodeState

[`NodeState`](../README.md#nodestate)

##### Returns

`number` \| `undefined`

---

### failedDepsOf()

> **failedDepsOf**(`run`, `nodeState`): `string`[]

#### Parameters

##### run

[`RunState`](../README.md#runstate)

##### nodeState

[`NodeState`](../README.md#nodestate)

#### Returns

`string`[]

---

### isOwnFailure()

> **isOwnFailure**(`run`, `nodeState`): `nodeState is FailedNodeState`

#### Parameters

##### run

[`RunState`](../README.md#runstate)

##### nodeState

[`NodeState`](../README.md#nodestate)

#### Returns

`nodeState is FailedNodeState`

---

### isSettled()

> **isSettled**(`nodeState`): `nodeState is SettledNodeState`

#### Parameters

##### nodeState

[`NodeState`](../README.md#nodestate)

#### Returns

`nodeState is SettledNodeState`

---

### nodeReports()

> **nodeReports**(`run`, `nodes?`): [`NodeReport`](../README.md#nodereport)[]

`nodes` as the run left them, in their order; the ones it never settled left out.

#### Parameters

##### run

[`RunState`](../README.md#runstate)

##### nodes?

`PassNode`[] = `...`

#### Returns

[`NodeReport`](../README.md#nodereport)[]

---

### nodesInFlight()

> **nodesInFlight**(`run`): [`InFlightNodeState`](../README.md#inflightnodestate)[]

The nodes dispatched and not settled, the earliest first.

#### Parameters

##### run

[`RunState`](../README.md#runstate)

#### Returns

[`InFlightNodeState`](../README.md#inflightnodestate)[]

---

### ownFailures()

> **ownFailures**(`run`): [`FailedNodeState`](../README.md#failednodestate)[]

#### Parameters

##### run

[`RunState`](../README.md#runstate)

#### Returns

[`FailedNodeState`](../README.md#failednodestate)[]

---

### runStartedAt()

> **runStartedAt**(`run`): `number` \| `undefined`

#### Parameters

##### run

[`RunState`](../README.md#runstate)

#### Returns

`number` \| `undefined`

---

### startedAtOf()

> **startedAtOf**(`nodeState`): `number` \| `undefined`

#### Parameters

##### nodeState

[`NodeState`](../README.md#nodestate)

#### Returns

`number` \| `undefined`
