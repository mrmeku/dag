import type { Node, Result } from "@mrmeku/dagraph";
import type { NodeReport } from "./report.ts";
import type {
  FailedNodeState,
  FailureNodeState,
  InFlightNodeState,
  NodeState,
  RunState,
  SettledNodeState,
} from "./run-slice.ts";

export { commandOf } from "../step-records.ts";

export const isSettled = (nodeState: NodeState): nodeState is SettledNodeState =>
  nodeState.status !== "pending" &&
  nodeState.status !== "dispatched" &&
  nodeState.status !== "running";

const isInFlight = (nodeState: NodeState): nodeState is InFlightNodeState =>
  nodeState.status === "dispatched" || nodeState.status === "running";

export const startedAtOf = (nodeState: NodeState): number | undefined =>
  "startedAt" in nodeState ? nodeState.startedAt : undefined;

/**
 * Whether the engine ran a node's action: its result has `elapsed`, as a build's always does, and
 * one that failed or was cancelled once its action ran. Never a cache hit or a skipped node.
 */
export const actionRan = <R extends Result>(
  result: R,
): result is R & { readonly elapsed: number } => "elapsed" in result;

/**
 * Whether a node's action ran to its end: built, or failed once its action ran; never a cache hit,
 * nor a node a cancel stopped while its action ran. Its duration is what last-run.json keeps, and
 * what the summary counts as busy and draws on its timeline.
 */
export const ranToItsEnd = (result: Result): boolean =>
  result.status !== "cancelled" && actionRan(result);

/**
 * The key whose CAS log holds what a node printed: the one it ran or found cached. None for a node
 * whose action did not run, though one that failed or was cancelled may have looked its key up.
 */
export function logKeyOf(nodeState: NodeState): string | undefined {
  switch (nodeState.status) {
    case "done":
    case "cached":
      return nodeState.result.actionKey;
    case "failed":
    case "cancelled":
      return actionRan(nodeState.result) ? nodeState.result.actionKey : undefined;
    case "pending":
    case "dispatched":
    case "running":
    case "dep-failed":
      return undefined;
  }
}

/**
 * How long a node took, at least 1 ms: the engine's `elapsed` for a node whose action ran, and a
 * cache hit's from its dispatch to its result. None for any other.
 */
export function durationOf(nodeState: SettledNodeState): number | undefined {
  switch (nodeState.status) {
    case "cached":
      return Math.max(1, nodeState.endedAt - nodeState.startedAt);
    case "dep-failed":
      return undefined;
    case "done":
    case "failed":
    case "cancelled":
      return actionRan(nodeState.result) ? Math.max(1, nodeState.result.elapsed) : undefined;
  }
}

/** The nodes dispatched and not settled, the earliest first. */
export const nodesInFlight = (run: RunState): InFlightNodeState[] =>
  [...run.nodes.values()]
    .filter(isInFlight)
    .sort((earlier, later) => earlier.startedAt - later.startedAt);

export function runStartedAt(run: RunState): number | undefined {
  const starts = [...run.nodes.values()].flatMap((nodeState) => startedAtOf(nodeState) ?? []);
  return starts.length > 0 ? Math.min(...starts) : undefined;
}

/** `nodes` as the run left them, in their order; the ones it never settled left out. */
export function nodeReports(
  run: RunState,
  nodes: Node[] = [...run.nodes.values()].map((nodeState) => nodeState.node),
): NodeReport[] {
  return nodes.flatMap((node): NodeReport[] => {
    const nodeState = run.nodes.get(node.name);
    if (!nodeState || !isSettled(nodeState)) return [];
    const start = startedAtOf(nodeState);
    const duration = durationOf(nodeState);
    const previous = run.lastRunDurations?.[node.name];
    return [
      {
        node,
        result: nodeState.result,
        ...(start !== undefined && { start }),
        ...(duration !== undefined && { duration }),
        ...(previous !== undefined && { previous }),
      },
    ];
  });
}

const isFailure = (nodeState: NodeState | undefined): nodeState is FailureNodeState =>
  nodeState?.status === "failed" || nodeState?.status === "dep-failed";

/** The deps of a node that failed, or were skipped because one of theirs did. */
export const getDependencyFailures = (run: RunState, nodeState: NodeState): FailureNodeState[] =>
  nodeState.node.deps.flatMap((dep) => {
    const depState = run.nodes.get(dep);
    return isFailure(depState) ? [depState] : [];
  });

/**
 * What a skipped node goes back to, as dagraph's `rootCauses`: the nodes along its required deps
 * that did not succeed and were not skipped themselves. None for any other node.
 */
export const causesOf = (nodeState: NodeState): string[] =>
  nodeState.status === "dep-failed" ? (nodeState.result.rootCauses ?? []) : [];

/** The nodes skipped because `failedName` failed. */
export const skippedBecauseOf = (run: RunState, failedName: string): string[] =>
  [...run.nodes.values()]
    .filter((nodeState) => causesOf(nodeState).includes(failedName))
    .map((nodeState) => nodeState.node.name);

export const failedNodes = (run: RunState): FailedNodeState[] =>
  [...run.nodes.values()].filter((nodeState) => nodeState.status === "failed");
