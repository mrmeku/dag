import type { Node } from "@mrmeku/dagraph";
import type { NodeReport } from "./report.ts";
import type {
  CancelledNodeState,
  DepFailedNodeState,
  FailedNodeState,
  InFlightNodeState,
  NodeState,
  RunState,
  SettledNodeState,
  SucceededNodeState,
} from "./run-slice.ts";

export const isSettled = (nodeState: NodeState): nodeState is SettledNodeState =>
  nodeState.status !== "pending" &&
  nodeState.status !== "dispatched" &&
  nodeState.status !== "running";

const isInFlight = (nodeState: NodeState): nodeState is InFlightNodeState =>
  nodeState.status === "dispatched" || nodeState.status === "running";

export const startedAtOf = (nodeState: NodeState): number | undefined =>
  "startedAt" in nodeState ? nodeState.startedAt : undefined;

/**
 * The key whose CAS log holds what a node printed: the one it ran or found cached. None for a node
 * that never started its action, though one that failed or was cancelled may have looked its key up.
 */
export function logKeyOf(nodeState: NodeState): string | undefined {
  switch (nodeState.status) {
    case "done":
    case "cached":
      return nodeState.actionKey;
    case "failed":
      return nodeState.failedWhile === "running" ? nodeState.actionKey : undefined;
    case "cancelled":
      return nodeState.cancelledWhile === "running" ? nodeState.actionKey : undefined;
    case "pending":
    case "dispatched":
    case "running":
    case "dep-failed":
      return undefined;
  }
}

/**
 * Whether a node ran its action here: built, or failed once its action started; never a cache hit.
 * A failed report that does not say `failedWhile` ran.
 */
export const ran = (node: {
  readonly status: NodeState["status"];
  readonly failedWhile?: FailedNodeState["failedWhile"];
}): boolean =>
  node.status === "done" || (node.status === "failed" && node.failedWhile !== "waiting");

/** From its action's start (a cache hit's dispatch) to its settle, at least 1 ms: always, for a node that ran to its end. */
export function durationOf(
  nodeState:
    | SucceededNodeState
    | Extract<FailedNodeState, { failedWhile: "running" }>
    | Extract<CancelledNodeState, { cancelledWhile: "running" }>,
): number;
export function durationOf(nodeState: NodeState): number | undefined;
export function durationOf(nodeState: NodeState): number | undefined {
  const startedAt = startedAtOf(nodeState);
  return startedAt === undefined || !isSettled(nodeState)
    ? undefined
    : Math.max(1, nodeState.endedAt - startedAt);
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
    const previous = run.lastRunDurations?.[node.name];
    const start = startedAtOf(nodeState);
    return [
      {
        ...node,
        status: nodeState.status,
        ...(start !== undefined && { start, duration: Math.max(1, nodeState.endedAt - start) }),
        ...("failedWhile" in nodeState && { failedWhile: nodeState.failedWhile }),
        ...(previous !== undefined && { previous }),
        ...("error" in nodeState && { error: nodeState.error }),
        ...("outputs" in nodeState && { outputs: nodeState.outputs }),
      },
    ];
  });
}

const isFailure = (
  nodeState: NodeState | undefined,
): nodeState is FailedNodeState | DepFailedNodeState =>
  nodeState?.status === "failed" || nodeState?.status === "dep-failed";

/** The deps of a node that failed, or were skipped because one of theirs did. */
export const getDependencyFailures = (
  run: RunState,
  nodeState: NodeState,
): Array<FailedNodeState | DepFailedNodeState> =>
  nodeState.node.deps.flatMap((dep) => {
    const depState = run.nodes.get(dep);
    return isFailure(depState) ? [depState] : [];
  });

/** The failed nodes a skipped one goes back to, through the skipped nodes between. */
export function causesOf(run: RunState, nodeState: NodeState): string[] {
  const causes = new Set<string>();
  const seen = new Set<string>();
  const visit = (dep: FailedNodeState | DepFailedNodeState) => {
    const name = dep.node.name;
    if (seen.has(name)) return;
    seen.add(name);
    if (dep.status === "dep-failed") getDependencyFailures(run, dep).forEach(visit);
    else causes.add(name);
  };
  getDependencyFailures(run, nodeState).forEach(visit);
  return [...causes];
}

/** The nodes skipped because `failedName` failed. */
export const skippedBecauseOf = (run: RunState, failedName: string): string[] =>
  [...run.nodes.values()]
    .filter(
      (nodeState) =>
        nodeState.status === "dep-failed" && causesOf(run, nodeState).includes(failedName),
    )
    .map((nodeState) => nodeState.node.name);

export const failedNodes = (run: RunState): FailedNodeState[] =>
  [...run.nodes.values()].filter((nodeState) => nodeState.status === "failed");
