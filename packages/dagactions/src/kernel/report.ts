import type { ExecResult, Node, Outputs } from "@mrmeku/dagraph";

type Status = ExecResult["status"];

/** One node as the run left it: the graph's node, plus how and when it settled. */
export interface NodeReport extends Node {
  status: Status;
  /** Epoch ms at dispatch, and dispatch to settle. Absent for a node never dispatched; a cache hit's is its cache check. */
  start?: number;
  duration?: number;
  /** Its duration the last time it was built or failed, from last-run.json. */
  previous?: number;
  /** The message of a fail or dep-failed. */
  error?: string;
  /** A done or cached node's outputs: paths into the CAS. */
  outputs?: Outputs;
}

export const namesOf = (nodes: NodeReport[], status: Status): string[] =>
  nodes.filter((node) => node.status === status).map((node) => node.name);

/** The failures no failure upstream explains: GitHub's rule for what failed and what to rerun. */
export function rootFailures(nodes: NodeReport[]): string[] {
  const failed = new Set(
    nodes
      .filter((node) => node.status === "fail" || node.status === "dep-failed")
      .map((node) => node.name),
  );
  return nodes
    .filter((node) => node.status === "fail" && !node.deps.some((dep) => failed.has(dep)))
    .map((node) => node.name);
}

export function wallTimeOf(nodes: NodeReport[]): number {
  const starts = nodes.flatMap((node) => node.start ?? []);
  const ends = nodes.flatMap((node) =>
    node.start === undefined ? [] : node.start + (node.duration ?? 0),
  );
  return starts.length > 0 ? Math.max(...ends) - Math.min(...starts) : 0;
}
