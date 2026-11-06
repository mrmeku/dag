import type { styleText } from "node:util";
import { join, quote } from "shlex";
import stringWidth from "string-width";
import {
  FAILURE_FULL_LINES,
  FAILURE_TAIL_LINES,
  LABEL_COLUMNS,
  NAME_MAX_COLUMNS,
  RECAP_NAMES_SHOWN,
  RERUN_COMMAND,
  SCROLLBACK_LINE_MAX_CHARS,
} from "../../config/index.ts";
import {
  STATUS_ICON,
  countsLine,
  failureMessage,
  logLines,
  plainLine,
  plural,
  rerunLine,
  runHeadline,
  selectors,
  titleOf,
  wallTimeOf,
  type FailedNodeState,
  type RunState,
  type SettledNodeState,
} from "../../kernel/index.ts";

export type Paint = (format: Parameters<typeof styleText>[0], text: string) => string;

/** Where the local display's files are, as the terminal and the failures report name them. */
export interface LocalFiles {
  /** A node's log file, once this run has written one. */
  logFile: (node: string) => string | undefined;
  workflowFile: string | undefined;
  failuresReportPath: string;
  logDir: string;
  summaryPath: string;
}

/** What the terminal's lines are drawn with: the local files, and how to paint and link. */
export interface LocalContext extends LocalFiles {
  paint: Paint;
  link: (path: string) => string;
}

/**
 * The command that reruns a workflow file locally, the file shell-quoted: `npx --no dag run 'ci
 * flows.ts'`; none without a file.
 */
export const localRerunCommand = (workflowFile: string | undefined): string | undefined =>
  workflowFile === undefined ? undefined : `${RERUN_COMMAND} ${quote(workflowFile)}`;

/** A duration as a clock reads: 4.0s, 1m04s. */
export function clockOf(durationMs: number): string {
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** The error says no more than the exit status does: `<cmd> exited <code>`. */
export function errorSaysOnlyExitCode({ result }: FailedNodeState): boolean {
  const command = selectors.commandOf(result.error);
  return command?.ended === "exited" && command.code !== 0 && !selectors.timedOut(result);
}

/** How a failure ended, when its error does not say it: `not started`, `timed out` or `exit 1`. */
function endingOf(nodeState: FailedNodeState): string {
  const { result } = nodeState;
  if (!selectors.actionRan(result)) return "not started";
  if (selectors.timedOut(result)) return "timed out";
  return errorSaysOnlyExitCode(nodeState) ? `exit ${selectors.commandOf(result.error)?.code}` : "";
}

/** How a node ended, how long it took and how much it printed: `exit 1 · 2.9s · 8 lines`. */
export function detailOf(nodeState: SettledNodeState): string {
  const duration = selectors.durationOf(nodeState);
  return [
    nodeState.status === "failed" ? endingOf(nodeState) : "",
    duration === undefined ? "" : clockOf(duration),
    nodeState.lineCount ? plural(nodeState.lineCount, "line") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Counts and wall time, none before a node settles. */
export function tallyOf(run: RunState): { countsLine: string; wallTime: number } | undefined {
  const nodeReports = selectors.nodeReports(run);
  if (nodeReports.length === 0) return undefined;
  return { countsLine: countsLine(nodeReports, String), wallTime: wallTimeOf(nodeReports) };
}

export const nameWidth = (names: Iterable<string>): number =>
  Math.min(NAME_MAX_COLUMNS, Math.max(0, ...[...names].map((name) => stringWidth(name))));

/** `name` padded to `columns` columns and never cut. */
export const padName = (name: string, columns: number): string =>
  name + " ".repeat(Math.max(0, columns - stringWidth(name)));

export const characterCountOf = (lines: string[]): number =>
  lines.reduce((count, line) => count + line.length + 1, 0);

const labelLine = (label: string, value: string, localContext: LocalContext): string =>
  `${localContext.paint("dim", label.padEnd(LABEL_COLUMNS))}${value}`;

/** A log's tail as the terminal shows it, within `maxCharacters` characters. */
export function tailLines(log: string[], maxCharacters = Infinity): string[] {
  const tail = log
    .slice(log.length <= FAILURE_FULL_LINES ? 0 : -FAILURE_TAIL_LINES)
    .map((line) => plainLine(line, SCROLLBACK_LINE_MAX_CHARS));
  while (tail.length > 0 && characterCountOf(tail) > maxCharacters) tail.shift();
  return tail;
}

/** A failure: how it ended, its log's tail and error, then what to read, run and rerun. */
export function failureBlockLines(
  nodeState: FailedNodeState,
  run: RunState,
  localContext: LocalContext,
  log: string[],
  tail = tailLines(log),
): string[] {
  const { paint } = localContext;
  const name = nodeState.node.name;
  const logFile = localContext.logFile(name);
  const alsoFailedDeps = selectors
    .getDependencyFailures(run, nodeState)
    .map((depState) => depState.node.name);
  const command = selectors.commandOf(nodeState.result.error);
  const labelledRows: Array<[label: string, value: string]> = [];
  if (logFile) labelledRows.push(["log", localContext.link(logFile)]);
  if (command)
    labelledRows.push(["cmd", `${join(command.argv)}   ${paint("dim", `(cwd ${command.cwd})`)}`]);
  if (alsoFailedDeps.length > 0)
    labelledRows.push(["deps", `${alsoFailedDeps.join(", ")} also failed`]);
  const rerunCommand = localRerunCommand(localContext.workflowFile);
  if (rerunCommand) labelledRows.push(["rerun", rerunLine(rerunCommand, [name])]);
  const earlierLineCount = log.length - tail.length;
  return [
    `${paint("red", STATUS_ICON.failed)} ${paint("bold", name)}  ${paint("dim", detailOf(nodeState))}`,
    ...[
      ...(earlierLineCount > 0
        ? [paint("dim", `… ${plural(earlierLineCount, "earlier line")}`)]
        : []),
      ...tail,
      ...(errorSaysOnlyExitCode(nodeState)
        ? []
        : logLines(failureMessage(nodeState)).map((line) => paint("red", line))),
    ].map((line) => `${paint("dim", "│")} ${line}`),
    ...labelledRows.map(([label, value], index) =>
      labelLine(`${index === labelledRows.length - 1 ? "└" : "├"} ${label}`, value, localContext),
    ),
  ];
}

export function failureLine(
  nodeState: FailedNodeState,
  nameColumns: number,
  localContext: LocalContext,
): string {
  const logFile = localContext.logFile(nodeState.node.name);
  return `${localContext.paint("red", STATUS_ICON.failed)} ${padName(nodeState.node.name, nameColumns)}   ${detailOf(nodeState)}${logFile ? `   ${localContext.link(logFile)}` : ""}`;
}

/**
 * The run's last lines: what it came to, the first `failuresShown` failures and what each brought
 * down, then what to rerun and read, the report with `hint` after it.
 */
export function recapLines(
  run: RunState,
  localContext: LocalContext,
  { failuresShown = Infinity, hint = "" } = {},
): string[] {
  const { paint } = localContext;
  const tally = tallyOf(run);
  const failures = selectors.failedNodes(run);
  const failedNames = failures.map((failure) => failure.node.name);
  const nameColumns = nameWidth(failedNames.slice(0, failuresShown));
  const abbreviatedNames = (names: string[]) =>
    names.length > RECAP_NAMES_SHOWN
      ? `${names.slice(0, RECAP_NAMES_SHOWN).join(", ")} +${names.length - RECAP_NAMES_SHOWN}`
      : names.join(", ");
  const lines = [
    "",
    `${paint("bold", runHeadline(run))} · ${titleOf(localContext.workflowFile)}${tally ? ` · wall ${clockOf(tally.wallTime)}` : ""}`,
    ...(tally ? [paint("dim", tally.countsLine)] : []),
    ...(failedNames.length > 0 ? [""] : []),
  ];
  for (const failure of failures.slice(0, failuresShown)) {
    const skipped = selectors.skippedBecauseOf(run, failure.node.name);
    lines.push(failureLine(failure, nameColumns, localContext));
    if (skipped.length > 0)
      lines.push(
        `  ${paint("yellow", STATUS_ICON["dep-failed"])} ${abbreviatedNames(skipped)} skipped because of it`,
      );
  }
  if (failedNames.length > failuresShown)
    lines.push(
      `${paint("red", STATUS_ICON.failed)} ${failedNames.length - failuresShown} more, in the report`,
    );
  lines.push("");
  const rerunCommand = localRerunCommand(localContext.workflowFile);
  if (failedNames.length > 0 && rerunCommand)
    lines.push(labelLine("rerun", rerunLine(rerunCommand, failedNames), localContext));
  if (failedNames.length > 0 || run.lifecycle.status === "errored")
    lines.push(
      labelLine(
        "report",
        `${localContext.link(localContext.failuresReportPath)}${paint("dim", hint)}`,
        localContext,
      ),
    );
  lines.push(labelLine("logs", `${localContext.link(localContext.logDir)}/`, localContext));
  return lines;
}
