import type { styleText } from "node:util";
import { quote } from "shlex";
import { SCROLLBACK_LINE_MAX_CHARS, STATUS_ICON } from "../config.ts";
import {
  annotationLine,
  cancelledHeadline,
  countsLine,
  logLines,
  plainLine,
  plural,
  reportHeadline,
  warningMessages,
} from "../kernel/format.ts";
import { namesOf, wallTimeOf } from "../kernel/report.ts";
import type { FailedNodeState, RunState, SettledNodeState } from "../kernel/run-slice.ts";
import * as selectors from "../kernel/selectors.ts";

export type Paint = (format: Parameters<typeof styleText>[0], text: string) => string;

/** What the terminal's lines and the failures report are drawn with. */
export interface LocalContext {
  paint: Paint;
  link: (path: string) => string;
  /** A node's log file, once this run has written one. */
  logFile: (node: string) => string | undefined;
  rerunCommand: string;
  workflowFile: string;
  failuresReportPath: string;
  logDir: string;
  summaryPath: string;
}

/** A duration as a clock reads: 4.0s, 1m04s. */
export function clockOf(durationMs: number): string {
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** How a node ended, how long it took and how much it printed: `exit 1 · 2.9s · 8 lines`. */
export function detailOf(nodeState: SettledNodeState): string {
  const duration = selectors.durationOf(nodeState);
  return [
    nodeState.status !== "failed"
      ? ""
      : nodeState.timedOut
        ? "timed out"
        : nodeState.command?.code
          ? `exit ${nodeState.command.code}`
          : "",
    duration === undefined ? "" : clockOf(duration),
    nodeState.lineCount ? plural(nodeState.lineCount, "line") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The error says no more than the exit status does: `<cmd> exited <code>`. */
export const errorSaysOnlyExitCode = (nodeState: FailedNodeState): boolean =>
  !!nodeState.command?.code && !nodeState.timedOut;

/** The messages of a node's warnings, from its log. */
export const warningsOf = (log: string[]): string[] =>
  warningMessages(log).filter((message) => message !== undefined);

/**
 * A node's warnings as the terminal prints them once it settles: each as the local host prints an
 * annotation, `[warning] lint: 2 files skipped`, plain.
 */
export const warningLines = (nodeName: string, messages: string[]): string[] =>
  messages.flatMap((message) =>
    logLines(annotationLine("warning", nodeName, message)).map((line) =>
      plainLine(line, SCROLLBACK_LINE_MAX_CHARS),
    ),
  );

/** A log without its warnings, which the terminal prints apart. */
export const withoutWarnings = (log: string[]): string[] => {
  const messages = warningMessages(log);
  return log.filter((_line, index) => messages[index] === undefined);
};

export const rerunLine = (rerunCommand: string, nodeNames: string[]): string =>
  `${rerunCommand} --only ${quote(nodeNames.join(","))}`;

/** That the run errored, its own failures, that it was cancelled, or else what it came to. */
export function runHeadline(run: RunState): string {
  if (run.lifecycle.status === "errored")
    return `${STATUS_ICON.failed} errored: ${logLines(run.lifecycle.error)[0] ?? ""}`;
  const nodeReports = selectors.nodeReports(run);
  const ownFailureNames = selectors.ownFailures(run).map((failure) => failure.node.name);
  if (ownFailureNames.length > 0) return reportHeadline(nodeReports, ownFailureNames);
  const notRunCount =
    namesOf(nodeReports, "cancelled").length + namesOf(nodeReports, "dep-failed").length;
  if (run.lifecycle.status === "cancelling" || run.lifecycle.status === "cancelled")
    return cancelledHeadline(notRunCount);
  return reportHeadline(nodeReports);
}

/** Counts and wall time, none before a node settles. */
export function tallyOf(run: RunState): { countsLine: string; wallTime: number } | undefined {
  const nodeReports = selectors.nodeReports(run);
  if (nodeReports.length === 0) return undefined;
  return { countsLine: countsLine(nodeReports, String), wallTime: wallTimeOf(nodeReports) };
}
