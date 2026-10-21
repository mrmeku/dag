# Run store API

Each output of dagworkflows is a listener of one run store. The GitHub log, the check runs, the three terminal styles, the log files and the failures report all read it. To draw a run in your own format, give the store a listener of your own.

```typescript
import { abortOnSignals, createRunStore, runJob } from "@mrmeku/dagworkflows";

const store = createRunStore({
  fs: ports.fs,
  clock: ports.clock,
  casBaseDir: ".dag/cas",
  listeners: [
    { settle: (nodeState) => console.log(`${nodeState.node.name}: ${nodeState.status}`) },
  ],
});
process.exitCode = await runJob(
  { implementation, ports, casBaseDir: ".dag/cas", store, signal: abortOnSignals() },
  process,
);
```

## The store

`createRunStore` follows Redux. `runReducer` is the only writer of the `RunState`: it turns each action (an event of the engine, a step's output among them, a pass that begins, a cancellation) into a new state, with a `NodeState` for each step. After each action the store tells its listeners. `store.getState()` returns the state, and `selectors` derives values from it, such as `selectors.nodesInFlight(store.getState())`.

A `NodeState` is a union on `status`: each variant has only the fields its status can have, so a `FailedNodeState` has an `error` and a `PendingNodeState` has no times. When a command fails, the `FailedNodeState` holds the command as `command`. This value comes from the `cause` of the error, a `CommandCause`: the arguments, the `cwd` and the exit status.

## Run a job

| Function      | What it does                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `runJob`      | Runs the job as `dag run` does: the run, the post pass after a cancellation, and then `close`. It returns the exit code. |
| `runWorkflow` | Runs one pass. Give it your store with `runWorkflow({ store })`.                                                         |
| `runPost`     | Runs the post pass.                                                                                                      |

Until `close` finishes, `runJob` changes a forced exit of the process into an `interrupt`. `runWorkflow` and `runPost` return a `RunOutcome`, which holds the `exitCode` of the pass.

## Observer events

A `RunListener` can have these functions. All are optional.

| Event              | When                                                            | Gets                                                                   |
| ------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `begin`            | A pass starts.                                                  | The pass, the run, and `isFirstPass`: true for the store's first pass. |
| `start`            | A step starts.                                                  | The step's state and the run.                                          |
| `settle`           | A step finishes, after dagworkflows reads its log from the CAS. | The step's state, the run and the log.                                 |
| `finish`           | A pass ends.                                                    | The pass and its `NodeReport`s, which the step summary draws.          |
| `close`            | The run ends.                                                   | The run, whose `lifecycle` says how it ended.                          |
| `interrupt`        | The process exits by force.                                     | The run.                                                               |
| `immediate.start`  | A step starts, immediately.                                     | The step's state.                                                      |
| `immediate.output` | A step prints a complete line, immediately.                     | The step's state and the new lines.                                    |

### Order

`begin`, `start`, `settle` and `finish` come in the order that the events occurred. Each gets the step as its event left it, and the run as it is at that time. A pass does not begin before all `settle` events of the last pass.

A post pass that has no work begins but does not finish. It has no banner, so it prints nothing.

`close` and `interrupt` go to the last listener first. Thus the first listener has the last word.

`run.lifecycle.status` is `running`, then `cancelling` after a cancellation, and at the end `finished`, `cancelled`, `errored` or `interrupted`. Only an `errored` lifecycle has an `error`: the message of what the run threw.

### Immediate events

`immediate.start` and `immediate.output` come immediately, before `settle` events that are still in progress. The GitHub check runs, the log files and the last line in the live footer use them.

These functions run inside the engine's event and the command's `data` listener. If one throws an error, the run fails, as for the ordered events. The command's stream does not break.

A line that the command did not end yet is the step's `unfinishedLine`. `unfinishedLine` keeps only the text after the last carriage return, as a terminal shows it. Thus a progress bar costs only its last line.

## The last run

`run.lastRunDurations` holds the time of each step in the last run. It comes from `last-run.json` in the CAS directory.

The store reads this file before it first writes it, because a step can restore the CAS that holds it. To read it when the run begins, set `lastRunAtBegin`.
