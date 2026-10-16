import type { ExecResult } from "@mrmeku/dagraph";
import { stripVTControlCharacters } from "node:util";
import { STATUS_ICON } from "../config.ts";
import { namesOf, rootFailures, type NodeReport } from "./report.ts";
import type { NodeState } from "./run-slice.ts";

const CONTROL_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What a run is called where its output needs a name: its workflow file. */
export const titleOf = (workflowFile: string | undefined): string => workflowFile ?? "run";

/** A log's lines as its group counts them: trailing blank lines and whitespace dropped. */
export function logLines(text: string): string[] {
  const trimmed = text.trimEnd();
  return trimmed ? trimmed.split("\n") : [];
}

export const textOf = (lines: string[]): string => lines.map((line) => `${line}\n`).join("");

/** A toolkit `::debug::` command (the globber writes one per file) is for GitHub's debug mode alone. */
export const isDebugCommand = (text: string): boolean => text.startsWith("::debug::");

/** What a terminal shows of a line: the text after its last carriage return, a trailing one aside. */
export const textAfterLastReturn = (line: string): string =>
  line.slice(line.replace(/\r+$/, "").lastIndexOf("\r") + 1);

/** A line as a terminal leaves it, plain, cut at `maxLength`. */
export function plainLine(line: string, maxLength = Infinity): string {
  const plainText = stripVTControlCharacters(
    textAfterLastReturn(line).slice(0, 2 * maxLength),
  ).replace(CONTROL_CHARACTERS, "");
  return plainText.length > maxLength ? `${plainText.slice(0, maxLength)}…` : plainText;
}

export const cancelledHeadline = (notRunCount: number): string =>
  `${STATUS_ICON.cancelled} cancelled, ${plural(notRunCount, "node")} not run`;

/** What the run came to, in a few words, naming `rootFailureNames` as what failed. */
export function reportHeadline(
  nodes: NodeReport[],
  rootFailureNames = rootFailures(nodes),
): string {
  const skippedCount = namesOf(nodes, "dep-failed").length;
  const cancelledCount = namesOf(nodes, "cancelled").length;
  if (rootFailureNames.length > 3)
    return `${STATUS_ICON.fail} ${rootFailureNames.slice(0, 3).join(", ")} and ${rootFailureNames.length - 3} more failed`;
  if (rootFailureNames.length > 0)
    return `${STATUS_ICON.fail} ${rootFailureNames.join(", ")} failed`;
  if (skippedCount > 0)
    return `${STATUS_ICON["dep-failed"]} ${plural(skippedCount, "node")} skipped, a dependency failed`;
  if (cancelledCount > 0) return cancelledHeadline(cancelledCount);
  return `${STATUS_ICON.done} ${nodes.length === 1 ? "1 node" : `all ${nodes.length} nodes`} succeeded`;
}

export function countsLine(nodes: NodeReport[], formatCount: (count: number) => string): string {
  const countOf = (status: ExecResult["status"]) => namesOf(nodes, status).length;
  return `built ${formatCount(countOf("done"))} · cached ${formatCount(countOf("cached"))} · failed ${formatCount(countOf("fail"))} · skipped ${formatCount(countOf("dep-failed"))}${countOf("cancelled") > 0 ? ` · cancelled ${formatCount(countOf("cancelled"))}` : ""}`;
}

/** A node's log as its group prints it: the log, then a failure's error; a skipped node's message. */
export function groupLines(nodeState: NodeState, log: string[]): string[] {
  if (nodeState.status === "fail") return [...log, "── error ──", ...logLines(nodeState.error)];
  if (nodeState.status === "dep-failed") return [nodeState.error];
  return log;
}
