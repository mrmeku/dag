/**
 * Starts a node's timer: calls `onTimeout` once `ms` milliseconds have passed, unless the stop it
 * returns is called first. An executor fills it from the global timers, and a test fires it by
 * hand.
 */
export type StartTimer = (ms: number, onTimeout: () => void) => () => void;

/**
 * Lookup-or-run's own events: `start`, as the action of a node that missed begins, and `output`,
 * for what the action prints.
 */
export type ActionEvent<Meta = unknown> = { node: string; meta?: Meta; occurredAt: number } & (
  | { type: "start" }
  | { type: "output"; chunk: string }
);

/**
 * Receives each `ActionEvent`. For `start` it may return a promise, and the action runs only once
 * it resolves, so a journal records the start before any effect: `onEvent: (event) =>
 * journal.record(event)`. A rejection fails the node without running it. The promise of an
 * `output` is not awaited, and its rejection is dropped.
 */
export type ActionListener<Meta = unknown> = (event: ActionEvent<Meta>) => void | Promise<void>;
