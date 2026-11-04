import type { ExecutionEvent, Node, NodeResult } from "@mrmeku/dagraph";
import { isDebugCommand, isWarningCommand, plainLine, textAfterLastReturn } from "./format.ts";
import { isSettled, startedAtOf } from "./selectors.ts";

/** What every node has: the pass's node and what its command printed. */
interface NodeLines {
  readonly node: Node;
  /** The line not yet ended, from its last carriage return: what a terminal still shows. */
  readonly unfinishedLine: string;
  /** The last line with text the node ended in this pass, plain, a warning command aside. */
  readonly lastLine: string;
  /** Whether the node ended a line in this pass. */
  readonly printed: boolean;
}

/** A settled node's log, once the store has read it. */
interface LogRead {
  readonly lineCount?: number;
  readonly log?: string[];
}

/** Not yet running: waiting on its deps, or held back by the scheduler, dispatched or not. */
export type PendingNodeState = NodeLines & { readonly status: "pending" };

/** Dispatched at `startedAt`, or running since its `start` came then. */
export type InFlightNodeState = NodeLines & {
  readonly status: "dispatched" | "running";
  readonly startedAt: number;
};

/** Settled as dagraph's `result` says, whose event came at `endedAt`. */
type SettledAs<Status extends NodeResult["status"]> = NodeLines &
  LogRead & {
    readonly status: Status;
    readonly result: Extract<NodeResult, { status: Status }>;
    readonly endedAt: number;
  };

/**
 * Its action ran, as its result's details' `elapsed` says, from `startedAt`, when its `start`
 * came; or it settled before its action ran, with no `elapsed` and no `startedAt`.
 */
type ActionRanOrNot =
  | {
      readonly startedAt: number;
      readonly result: { readonly details: { readonly elapsed: number } };
    }
  | {
      readonly startedAt?: undefined;
      readonly result: { readonly details?: { readonly elapsed?: never } };
    };

/**
 * Built since its `start` came at `startedAt`, or a cache hit since its dispatch then, as its
 * details' `actionRan` says.
 */
export type SucceededNodeState = SettledAs<"succeeded"> & { readonly startedAt: number };

/**
 * Failed once its action ran, or before it could: its key not computed or its `RunNode` rejected
 * (its result has no details), its attempt not set up, its start not recorded, or its inputs not
 * resolved.
 */
export type FailedNodeState = SettledAs<"failed"> & ActionRanOrNot;

/** Skipped because a required dependency did not succeed: never dispatched. */
export type DepFailedNodeState = SettledAs<"dep-failed">;

/**
 * Cancelled once its action ran, or while it waited, though it may have looked its key up: its
 * result has no details for one cancelled before it had one.
 */
export type CancelledNodeState = SettledAs<"cancelled"> & ActionRanOrNot;

/** A failure: failed, or skipped because a required dependency did not succeed. */
export type FailureNodeState = FailedNodeState | DepFailedNodeState;

export type SettledNodeState =
  | SucceededNodeState
  | FailedNodeState
  | DepFailedNodeState
  | CancelledNodeState;

/**
 * One node as far as the run has got with it. A miss the scheduler holds back pends between its
 * dispatch and its start, which is not its time.
 */
export type NodeState = PendingNodeState | InFlightNodeState | SettledNodeState;

/** How the run stands: running until a cancel or its close, then final. Only an errored run has an error. */
export type RunLifecycle =
  | { readonly status: "running" | "cancelling" | "finished" | "cancelled" | "interrupted" }
  | { readonly status: "errored"; readonly error: string };

/** The nodes of every pass (a post pass replaces those it owes) and the last run's durations. */
export interface RunState {
  readonly nodes: ReadonlyMap<string, NodeState>;
  readonly lastRunDurations?: Readonly<Record<string, number>>;
  readonly lifecycle: RunLifecycle;
}

/**
 * One pass of the runner: the run, or the post pass after a cancel. A post pass that owes
 * nothing is begun and never finished; GitHub still opens its banner's group.
 */
export interface Pass {
  banner?: { title: string; lines: string[] };
  title: string;
  nodes: Node[];
  rerunCommand?: string;
}

/** An engine event as dagraph emits it, or a settled node's log once the store has read it. */
export type NodeAction =
  | ExecutionEvent
  | { type: "logRead"; settled: SettledNodeState; log: string[] };

export type RunAction =
  | NodeAction
  | { type: "passBegun"; pass: Pass }
  | { type: "runCancelled" }
  | { type: "runClosed" }
  | { type: "runErrored"; error: string }
  | { type: "runInterrupted" }
  | { type: "lastRunRead"; durations: Record<string, number> };

export const initialRunState: RunState = { nodes: new Map(), lifecycle: { status: "running" } };

export const initialNodeState = (node: Node): PendingNodeState => ({
  node,
  status: "pending",
  unfinishedLine: "",
  lastLine: "",
  printed: false,
});

/** `line`, not yet ended, after `chunk`: redrawn from the chunk's last carriage return, if any. */
function redrawnLine(line: string, chunk: string): string {
  const text = chunk.replace(/\r+$/, "");
  if (text.includes("\r")) return textAfterLastReturn(chunk);
  return text && line.endsWith("\r") ? chunk : line + chunk;
}

/**
 * The line not yet ended after `chunk`. Only the chunk is searched, and of that line only what a
 * terminal still shows is kept, so a progress bar redrawn with carriage returns costs no more
 * than its last redraw.
 */
function unfinishedLineAfter(unfinishedLine: string, chunk: string): string {
  const end = chunk.lastIndexOf("\n");
  return end < 0 ? redrawnLine(unfinishedLine, chunk) : textAfterLastReturn(chunk.slice(end + 1));
}

/** The lines `chunk` ends after `unfinishedLine`, plain, blank ones kept and debug commands dropped. */
export function completedLines(unfinishedLine: string, chunk: string): string[] {
  const end = chunk.lastIndexOf("\n");
  if (end < 0) return [];
  return (unfinishedLine + chunk.slice(0, end))
    .split("\n")
    .map((line) => plainLine(line))
    .filter((line) => !isDebugCommand(line));
}

/** What `chunk` makes of a node's lines: the one left unfinished, and those it ends. */
function linesAfter(state: NodeState, chunk: string) {
  const ended = completedLines(state.unfinishedLine, chunk);
  return {
    unfinishedLine: unfinishedLineAfter(state.unfinishedLine, chunk),
    lastLine: ended.findLast((line) => line.trim() && !isWarningCommand(line)) ?? state.lastLine,
    printed: state.printed || ended.length > 0,
  };
}

/** A settled node once its log is read. */
export function settledWithLog(state: SettledNodeState, log: string[]): SettledNodeState {
  return { ...state, lineCount: log.length, log };
}

/** A node after `action`. */
export function nodeReducer(state: NodeState, action: NodeAction): NodeState {
  switch (action.type) {
    case "output":
      return { ...state, ...linesAfter(state, action.chunk) };
    case "logRead":
      return isSettled(state) ? settledWithLog(state, action.log) : state;
  }
  const { occurredAt } = action;
  const lines = {
    node: state.node,
    unfinishedLine: state.unfinishedLine,
    lastLine: state.lastLine,
    printed: state.printed,
  };
  if (action.type === "dispatch") return { ...lines, status: "dispatched", startedAt: occurredAt };
  if (action.type === "pending") return { ...lines, status: "pending" };
  if (action.type === "start") return { ...lines, status: "running", startedAt: occurredAt };
  // The command has exited, ending its unfinished line if it left one.
  const ended = {
    ...lines,
    ...(state.unfinishedLine && linesAfter(state, "\n")),
    unfinishedLine: "",
    endedAt: occurredAt,
  };
  const { result } = action;
  // From its start, or a cache hit's dispatch; a node settled unheard of is timed from its settle.
  const startedAt = startedAtOf(state) ?? occurredAt;
  switch (result.status) {
    case "succeeded":
      return { ...ended, status: "succeeded", result, startedAt };
    case "failed": {
      const { details, ...rest } = result;
      if (details && "elapsed" in details)
        return { ...ended, status: "failed", result: { ...rest, details }, startedAt };
      return { ...ended, status: "failed", result: { ...rest, ...(details && { details }) } };
    }
    case "dep-failed":
      return { ...ended, status: "dep-failed", result };
    case "cancelled": {
      const { details, ...rest } = result;
      if (details?.elapsed === undefined)
        return {
          ...ended,
          status: "cancelled",
          result: { ...rest, ...(details && { details: { actionKey: details.actionKey } }) },
        };
      const { elapsed, actionKey } = details;
      return {
        ...ended,
        status: "cancelled",
        result: { ...rest, details: { actionKey, elapsed } },
        startedAt,
      };
    }
  }
}

const withNode = (state: RunState, nodeState: NodeState): RunState => ({
  ...state,
  nodes: new Map(state.nodes).set(nodeState.node.name, nodeState),
});

/** `state` with `lifecycle`, unless the run has already ended. */
const withLifecycle = (state: RunState, lifecycle: RunLifecycle): RunState =>
  state.lifecycle.status === "running" || state.lifecycle.status === "cancelling"
    ? { ...state, lifecycle }
    : state;

/** The run after `action`, the only writer of RunState. */
export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case "passBegun": {
      const nodes = new Map(state.nodes);
      for (const node of action.pass.nodes) nodes.set(node.name, initialNodeState(node));
      return { ...state, nodes };
    }
    case "runCancelled":
      return state.lifecycle.status === "running"
        ? { ...state, lifecycle: { status: "cancelling" } }
        : state;
    case "runClosed":
      return withLifecycle(state, {
        status: state.lifecycle.status === "cancelling" ? "cancelled" : "finished",
      });
    case "runErrored":
      return withLifecycle(state, { status: "errored", error: action.error });
    case "runInterrupted":
      return withLifecycle(state, { status: "interrupted" });
    case "lastRunRead":
      return { ...state, lastRunDurations: action.durations };
    case "logRead": {
      // Unless a later pass has taken the node up since.
      const current = state.nodes.get(action.settled.node.name);
      return current === action.settled ? withNode(state, nodeReducer(current, action)) : state;
    }
    default: {
      // An event names its node; a node no pass began is not the run's.
      const current = state.nodes.get(action.node);
      return current ? withNode(state, nodeReducer(current, action)) : state;
    }
  }
}
