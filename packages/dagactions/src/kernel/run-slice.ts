import type { ExecEvent, Node, Outputs, Result } from "@mrmeku/dagraph";
import { commandOf, type CommandCause } from "../step-records.ts";
import {
  depFailedMessage,
  formatDuration,
  isDebugCommand,
  plainLine,
  textAfterLastReturn,
} from "./format.ts";
import { isSettled, startedAtOf } from "./selectors.ts";

/** What every node has: the graph's node and what its command printed. */
interface NodeLines {
  readonly node: Node;
  /** The line not yet ended, from its last carriage return: what a terminal still shows. */
  readonly unfinishedLine: string;
  /** The last line with text the node ended in this pass, plain. */
  readonly lastLine: string;
  /** Whether the node ended a line in this pass. */
  readonly printed: boolean;
}

/** A settled node's CAS log, once the store has read it. */
interface LogRead {
  readonly lineCount?: number;
}

export type PendingNodeState = NodeLines & { readonly status: "pending" };

export type InFlightNodeState = NodeLines & {
  readonly status: "dispatched" | "running";
  readonly startedAt: number;
};

export type SucceededNodeState = NodeLines &
  LogRead & {
    readonly status: "done" | "cached";
    readonly startedAt: number;
    readonly endedAt: number;
    readonly actionKey: string;
    readonly outputs: Outputs;
  };

export type FailedNodeState = NodeLines &
  LogRead & {
    readonly status: "failed";
    readonly startedAt: number;
    readonly endedAt: number;
    readonly actionKey: string;
    readonly error: string;
    readonly timedOut: boolean;
    /** A failed command, from its error's cause. */
    readonly command?: CommandCause;
    /** The CAS log, kept for the failure's block and report. */
    readonly log?: string[];
  };

/** Skipped because a dependency failed: never dispatched. */
export type SkippedNodeState = NodeLines &
  LogRead & { readonly status: "dep-failed"; readonly endedAt: number; readonly error: string };

/** Dispatched or not; `actionKey` is "" for one cancelled before it had one. */
export type CancelledNodeState = NodeLines &
  LogRead & {
    readonly status: "cancelled";
    readonly startedAt?: number;
    readonly endedAt: number;
    readonly actionKey: string;
  };

export type SettledNodeState =
  | SucceededNodeState
  | FailedNodeState
  | SkippedNodeState
  | CancelledNodeState;

/**
 * One node as far as the run has got with it. Every duration is `endedAt - startedAt`: from when
 * its action started, or for a node that settled without starting, such as a cache hit, from its
 * dispatch. A miss waits for its concurrency group's slot between the two, which is not its time.
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

/**
 * An engine event, stamped with when it came (what a node prints needs no time), or what the
 * run's own steps add to it.
 */
export type NodeAction =
  | (Exclude<ExecEvent, { type: "output" }> & { occurredAt: number })
  | Extract<ExecEvent, { type: "output" }>
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

type FailedError = Extract<Result, { status: "failed" }>["error"];

const isTimeout = (error: FailedError): boolean => error.name === "TimeoutError";

/** A failure's message; a timeout in the words of GitHub's runner. */
function failureMessage(node: Node, error: FailedError): string {
  if (!isTimeout(error) || node.timeoutMs === undefined) return error.message;
  const minutes = node.timeoutMs / 60_000;
  const after =
    minutes >= 1
      ? `${+minutes.toFixed(2)} minute${minutes === 1 ? "" : "s"}`
      : formatDuration(node.timeoutMs);
  return `The action '${node.name}' has timed out after ${after}.`;
}

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
    lastLine: ended.findLast((line) => line.trim()) ?? state.lastLine,
    printed: state.printed || ended.length > 0,
  };
}

/** A settled node once its log is read. */
export function settledWithLog(state: SettledNodeState, log: string[]): SettledNodeState {
  if (state.status === "failed") return { ...state, lineCount: log.length, log };
  return { ...state, lineCount: log.length };
}

/** A node after `action`. A node that settles without a dispatch is timed from its settle. */
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
  if (action.type === "start") return { ...lines, status: "running", startedAt: occurredAt };
  // The command has exited, ending its unfinished line if it left one.
  const ended = {
    ...lines,
    ...(state.unfinishedLine && linesAfter(state, "\n")),
    unfinishedLine: "",
    endedAt: occurredAt,
  };
  const { result } = action;
  switch (result.status) {
    case "done":
    case "cached":
      return {
        ...ended,
        status: result.status,
        startedAt: startedAtOf(state) ?? occurredAt,
        actionKey: result.actionKey,
        outputs: result.outputs,
      };
    case "failed": {
      const command = commandOf(result.error);
      return {
        ...ended,
        status: "failed",
        startedAt: startedAtOf(state) ?? occurredAt,
        actionKey: result.actionKey,
        error: failureMessage(state.node, result.error),
        timedOut: isTimeout(result.error),
        ...(command && { command }),
      };
    }
    case "dep-failed":
      return { ...ended, status: "dep-failed", error: depFailedMessage(result.dep) };
    case "cancelled": {
      const startedAt = startedAtOf(state);
      return {
        ...ended,
        status: "cancelled",
        actionKey: result.actionKey,
        ...(startedAt !== undefined && { startedAt }),
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
