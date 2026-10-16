# The run kernel

The kernel follows Redux where its code is state transitions, and only there.

- `run-slice.ts`: `RunState`, `NodeState`, the actions and the reducers. `runReducer` is the only writer of `RunState`; it returns a new state and never mutates one. Reducers are pure: the store stamps an engine event with `occurredAt`, a reducer never reads the clock. Actions are events, named in the past tense (`passBegun`, `outputPrinted`), and the engine's `ExecEvent` is an action as it is, never wrapped in a type of ours.
- State types make impossible states unrepresentable: `NodeState` is a union on `status` and `RunState.lifecycle` a union on its own `status`, each variant holding only the fields it can have (an `error` only where something failed). A reducer builds a new variant from the shared fields, never by spreading another variant, which TypeScript would not check. Narrow on `status` or use a selector (`dispatchedAtOf`, `actionKeyOf`) instead of asserting with `!`.
- `store.ts`: `createRunStore`. `dispatch` reduces, then tells the `RunListener`s what the action means: at once for `immediate` hooks, in order on its queue for the rest. Effects that do IO (the CAS log, last-run.json) dispatch what they learn. `begin`, `cancel`, `onEvent` and `onOutput` are bound action creators for the runner and the engine.
- `selectors.ts`: every pure value derived from `RunState` or a `NodeState`, imported as `import * as selectors from ".../kernel/selectors.ts"` and called as `selectors.x(run)`. Names carry no `select` prefix; the namespace says it.
- `report.ts`: `NodeReport`, the summary's published shape, and what is derived from a list of them.
- `format.ts`: all text.

Redux vocabulary stops at the kernel's edge: renderers and recorders are listeners, and their own code is plain. No Redux Toolkit (listener effects run concurrently; ours must run in order) and no Flux Standard Action envelopes.
