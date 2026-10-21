import type { Node } from "@mrmeku/dagraph";
import type { NodeReport } from "./report.ts";
import type {
  FailedNodeState,
  InFlightNodeState,
  NodeState,
  RunState,
  SettledNodeState,
  SkippedNodeState,
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

/** "" for a node cancelled before it had one, none for a skipped or unsettled one. */
export const actionKeyOf = (nodeState: NodeState): string | undefined =>
  "actionKey" in nodeState ? nodeState.actionKey : undefined;

/** From its action's start (a cache hit's dispatch) to its settle, at least 1 ms: always, for a node that ran to its end. */
export function durationOf(nodeState: SucceededNodeState | FailedNodeState): number;
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
        ...(previous !== undefined && { previous }),
        ...("error" in nodeState && { error: nodeState.error }),
        ...("outputs" in nodeState && { outputs: nodeState.outputs }),
      },
    ];
  });
}

/*
 * The terminal's and failures.md's rule for which failures to fix: a node that ran its command
 * failed for its own reason, even after a failed settled dep. GitHub's log names the failures no
 * failure upstream explains instead (`rootFailures` in report.ts).
 */

const isFailed = (
  nodeState: NodeState | undefined,
): nodeState is FailedNodeState | SkippedNodeState =>
  nodeState?.status === "failed" || nodeState?.status === "dep-failed";

const failedDepStatesOf = (run: RunState, nodeState: NodeState): NodeState[] =>
  nodeState.node.deps.flatMap((dep) => {
    const depState = run.nodes.get(dep);
    return isFailed(depState) ? [depState] : [];
  });

export const failedDepsOf = (run: RunState, nodeState: NodeState): string[] =>
  failedDepStatesOf(run, nodeState).map((depState) => depState.node.name);

/**
 * Failed because a dep did: skipped, or failed running no command of its own, as a
 * `workflow.requireAll` node does.
 */
const isConsequence = (run: RunState, nodeState: NodeState): boolean =>
  nodeState.status === "dep-failed" ||
  (nodeState.status === "failed" && !nodeState.command && failedDepsOf(run, nodeState).length > 0);

export const isOwnFailure = (run: RunState, nodeState: NodeState): nodeState is FailedNodeState =>
  nodeState.status === "failed" && !isConsequence(run, nodeState);

export const ownFailures = (run: RunState): FailedNodeState[] =>
  [...run.nodes.values()].filter((nodeState) => isOwnFailure(run, nodeState));

/** The own failures a consequence goes back to, through the failed nodes between. */
export function causesOf(run: RunState, nodeState: NodeState): string[] {
  const causes = new Set<string>();
  const seen = new Set<string>();
  const visit = (dep: NodeState) => {
    const name = dep.node.name;
    if (seen.has(name)) return;
    seen.add(name);
    if (isConsequence(run, dep)) failedDepStatesOf(run, dep).forEach(visit);
    else causes.add(name);
  };
  failedDepStatesOf(run, nodeState).forEach(visit);
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
  return { failed: namesWithStatus("failed"), skipped: namesWithStatus("dep-failed") };
}
