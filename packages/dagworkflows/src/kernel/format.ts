import type { Result } from "@mrmeku/dagraph";
import { stripVTControlCharacters } from "node:util";
import { STATUS_ICON } from "../config.ts";
import type { AnnotationLevel } from "../ports.ts";
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

/** Why a node did not run: a required dep did not succeed. */
export const depFailedMessage = (dep: string): string => `dependency ${dep} failed`;

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

/** An annotation as the local host prints it: `[warning] lint: 2 files skipped`. */
export const annotationLine = (level: AnnotationLevel, title: string, message: string): string =>
  `[${level}] ${title}: ${message}`;

/**
 * The message of each line of `log` that is a `::warning` workflow command, at its index, as
 * GitHub's runner reads one: after leading whitespace, in any case, unescaped, and none while a
 * `::stop-commands::` holds the commands off. Any other line has `undefined`.
 */
export function warningMessages(log: string[]): Array<string | undefined> {
  let stopToken: string | undefined;
  return log.map((line) => {
    // .NET's TrimStart, which the runner uses, also strips U+0085.
    const trimmed = line.replace(/^[\s\u0085]+/, "");
    const end = trimmed.startsWith("::") ? trimmed.indexOf("::", 2) : -1;
    if (end < 0) return undefined;
    const command = trimmed.slice(2, end).split(" ")[0]?.toLowerCase();
    const data = trimmed.slice(end + 2);
    if (stopToken !== undefined) {
      if (command === stopToken.toLowerCase()) stopToken = undefined;
      return undefined;
    }
    if (command === "stop-commands") stopToken = data;
    if (command !== "warning") return undefined;
    return data.replaceAll("%0D", "\r").replaceAll("%0A", "\n").replaceAll("%25", "%");
  });
}

/** Whether a line is a `::warning` workflow command, which the terminal prints apart. */
export const isWarningCommand = (line: string): boolean => warningMessages([line])[0] !== undefined;

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
    return `${STATUS_ICON.failed} ${rootFailureNames.slice(0, 3).join(", ")} and ${rootFailureNames.length - 3} more failed`;
  if (rootFailureNames.length > 0)
    return `${STATUS_ICON.failed} ${rootFailureNames.join(", ")} failed`;
  if (skippedCount > 0)
    return `${STATUS_ICON["dep-failed"]} ${plural(skippedCount, "node")} skipped, a dependency failed`;
  if (cancelledCount > 0) return cancelledHeadline(cancelledCount);
  return `${STATUS_ICON.done} ${nodes.length === 1 ? "1 node" : `all ${nodes.length} nodes`} succeeded`;
}

export function countsLine(nodes: NodeReport[], formatCount: (count: number) => string): string {
  const countOf = (status: Result["status"]) => namesOf(nodes, status).length;
  return `built ${formatCount(countOf("done"))} · cached ${formatCount(countOf("cached"))} · failed ${formatCount(countOf("failed"))} · skipped ${formatCount(countOf("dep-failed"))}${countOf("cancelled") > 0 ? ` · cancelled ${formatCount(countOf("cancelled"))}` : ""}`;
}

/** A node's log as its group prints it: the log, then a failure's error; a skipped node's message. */
export function groupLines(nodeState: NodeState, log: string[]): string[] {
  if (nodeState.status === "failed") return [...log, "── error ──", ...logLines(nodeState.error)];
  if (nodeState.status === "dep-failed") return [nodeState.error];
  return log;
}
