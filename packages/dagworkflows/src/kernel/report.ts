import type { Node, Result } from "@mrmeku/dagraph";

/** One node as the run left it: the pass's node, dagraph's result, and the run store's timing. */
export interface NodeReport {
  node: Node;
  result: Result;
  /** Epoch ms its `start` came, for a node whose action ran, or a cache hit's dispatch; absent for any other node. */
  start?: number;
  /** At least 1 ms: the engine's `elapsed` once its action ran, or a cache hit's from dispatch to result. */
  duration?: number;
  /** Its duration the last time it was built, or failed once its action ran, from last-run.json. */
  previous?: number;
}

export const namesOf = (nodes: NodeReport[], status: Result["status"]): string[] =>
  nodes.filter(({ result }) => result.status === status).map(({ node }) => node.name);

export function wallTimeOf(nodes: NodeReport[]): number {
  const starts = nodes.flatMap((report) => report.start ?? []);
  const ends = nodes.flatMap((report) =>
    report.start === undefined ? [] : report.start + (report.duration ?? 0),
  );
  return starts.length > 0 ? Math.max(...ends) - Math.min(...starts) : 0;
}
