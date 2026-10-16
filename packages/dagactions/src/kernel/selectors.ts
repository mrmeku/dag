import type { Node } from "@mrmeku/dagraph";
import type { NodeReport } from "./report.ts";
import type {
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

export const dispatchedAtOf = (nodeState: NodeState): number | undefined =>
  "dispatchedAt" in nodeState ? nodeState.dispatchedAt : undefined;

/** "" for a node cancelled before it had one, none for a skipped or unsettled one. */
export const actionKeyOf = (nodeState: NodeState): string | undefined =>
  "actionKey" in nodeState ? nodeState.actionKey : undefined;

/** Dispatch to settle, at least 1 ms: always, for a node that ran to its end. */
export function durationOf(nodeState: SucceededNodeState | FailedNodeState): number;
export function durationOf(nodeState: NodeState): number | undefined;
export function durationOf(nodeState: NodeState): number | undefined {
  const dispatchedAt = dispatchedAtOf(nodeState);
  return dispatchedAt === undefined || !isSettled(nodeState)
    ? undefined
    : Math.max(1, nodeState.endedAt - dispatchedAt);
}

/** The nodes dispatched and not settled, the earliest first. */
export const nodesInFlight = (run: RunState): InFlightNodeState[] =>
  [...run.nodes.values()]
    .filter(isInFlight)
    .sort((earlier, later) => earlier.dispatchedAt - later.dispatchedAt);

export function runStartedAt(run: RunState): number | undefined {
  const starts = [...run.nodes.values()].flatMap((nodeState) => dispatchedAtOf(nodeState) ?? []);
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
    const start = dispatchedAtOf(nodeState);
    return [
      {
        ...node,
        status: nodeState.status,
        ...(start !== undefined && { start, duration: Math.max(1, nodeState.endedAt - start) }),
        ...(previous !== undefined && { previous }),
        ...("error" in nodeState && { error: nodeState.error }),
        ...("outputs" in nodeState && { outputs: nodeState.outputs }),
      },
    ];
  });
}

/*
 * The terminal's and failures.md's rule for which failures to fix: a node that ran its command
 * failed for its own reason, even after a failed optional dep. GitHub's log names the failures no
 * failure upstream explains instead (`rootFailures` in report.ts).
 */

const isFailed = (nodeState: NodeState | undefined): boolean =>
  nodeState?.status === "fail" || nodeState?.status === "dep-failed";

export const failedDepsOf = (run: RunState, nodeState: NodeState): string[] =>
  nodeState.node.deps.filter((dep) => isFailed(run.nodes.get(dep)));

/** Failed because a dep did: skipped, or failed running no command of its own, as a gate does. */
const isConsequence = (run: RunState, nodeState: NodeState): boolean =>
  nodeState.status === "dep-failed" ||
  (nodeState.status === "fail" && !nodeState.command && failedDepsOf(run, nodeState).length > 0);

export const isOwnFailure = (run: RunState, nodeState: NodeState): nodeState is FailedNodeState =>
  nodeState.status === "fail" && !isConsequence(run, nodeState);

export const ownFailures = (run: RunState): FailedNodeState[] =>
  [...run.nodes.values()].filter((nodeState) => isOwnFailure(run, nodeState));

/** The own failures a consequence goes back to, through the failed nodes between. */
export function causesOf(run: RunState, nodeState: NodeState): string[] {
  const causes = new Set<string>();
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const dep = run.nodes.get(name)!;
    if (isConsequence(run, dep)) failedDepsOf(run, dep).forEach(visit);
    else causes.add(name);
  };
  failedDepsOf(run, nodeState).forEach(visit);
  return [...causes];
}

export function consequencesOf(
  run: RunState,
  ownFailureName: string,
): { failed: string[]; skipped: string[] } {
  const consequences = [...run.nodes.values()].filter(
    (nodeState) =>
      isConsequence(run, nodeState) && causesOf(run, nodeState).includes(ownFailureName),
  );
  const namesWithStatus = (status: NodeState["status"]) =>
    consequences
      .filter((nodeState) => nodeState.status === status)
      .map((nodeState) => nodeState.node.name);
  return { failed: namesWithStatus("fail"), skipped: namesWithStatus("dep-failed") };
}
