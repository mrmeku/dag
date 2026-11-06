import { SCROLLBACK_LINE_MAX_CHARS } from "../../config/index.ts";
import { warningsOf } from "../../github-workflow-commands/index.ts";
import {
  STATUS_ICON,
  logLines,
  plainLine,
  selectors,
  type FailedNodeState,
  type Pass,
  type RunState,
} from "../../kernel/index.ts";
import type { LocalContext } from "../words/index.ts";

/** A pass's title: the first with `titleSuffix`, where the style points; a later one if it has nodes. */
export function passLines(pass: Pass, localContext: LocalContext, titleSuffix?: string): string[] {
  const title = localContext.paint("bold", pass.banner?.title ?? pass.title);
  if (titleSuffix !== undefined) return [`${title} · ${titleSuffix}`];
  return pass.nodes.length > 0 ? [title] : [];
}

/** The messages of a node's warnings, from its log. */
export const warningMessagesOf = (log: string[]): string[] =>
  warningsOf(log).map(({ message }) => message);

/**
 * A node's warnings as the terminal prints them once it settles: each as the local host prints an
 * annotation, `[warning] lint: 2 files skipped`, plain.
 */
export const warningLines = (nodeName: string, messages: string[]): string[] =>
  messages.flatMap((message) =>
    logLines(`[warning] ${nodeName}: ${message}`).map((line) =>
      plainLine(line, SCROLLBACK_LINE_MAX_CHARS),
    ),
  );

/** A log without its warnings, which the terminal prints apart. */
const withoutWarnings = (log: string[]): string[] => {
  const warningLineIndexes = new Set(warningsOf(log).map(({ line }) => line));
  return log.filter((_line, index) => !warningLineIndexes.has(index));
};

/** A failure's log as its block shows it: its warnings print after the block. */
export const blockLog = (nodeState: FailedNodeState): string[] =>
  withoutWarnings(nodeState.log ?? []);

export function interruptedLines(run: RunState, localContext: LocalContext): string[] {
  const stoppedNames = selectors.nodesInFlight(run).map((nodeState) => nodeState.node.name);
  return [
    "",
    `${localContext.paint("gray", STATUS_ICON.cancelled)} forced exit${stoppedNames.length > 0 ? ` while ${stoppedNames.join(", ")} ran` : ""} · report ${localContext.link(localContext.failuresReportPath)}`,
  ];
}
