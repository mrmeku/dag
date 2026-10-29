import { join } from "shlex";
import stringWidth from "string-width";
import {
  FAILURE_FULL_LINES,
  FAILURE_TAIL_LINES,
  LABEL_COLUMNS,
  NAME_MAX_COLUMNS,
  RECAP_NAMES_SHOWN,
  SCROLLBACK_LINE_MAX_CHARS,
  STATUS_ICON,
} from "../../config.ts";
import {
  failureMessage,
  logLines,
  plainLine,
  plural,
  rerunLine,
  titleOf,
} from "../../kernel/format.ts";
import type { FailedNodeState, Pass, RunState } from "../../kernel/run-slice.ts";
import * as selectors from "../../kernel/selectors.ts";
import {
  clockOf,
  detailOf,
  errorSaysOnlyExitCode,
  runHeadline,
  tallyOf,
  withoutWarnings,
  type LocalContext,
} from "../words.ts";

export const nameWidth = (names: Iterable<string>): number =>
  Math.min(NAME_MAX_COLUMNS, Math.max(0, ...[...names].map((name) => stringWidth(name))));

/** `name` padded to `columns` columns and never cut. */
export const padName = (name: string, columns: number): string =>
  name + " ".repeat(Math.max(0, columns - stringWidth(name)));

export const characterCountOf = (lines: string[]): number =>
  lines.reduce((count, line) => count + line.length + 1, 0);

const labelLine = (label: string, value: string, localContext: LocalContext): string =>
  `${localContext.paint("dim", label.padEnd(LABEL_COLUMNS))}${value}`;

/** A pass's title: the first with `titleSuffix`, where the style points; a later one if it has nodes. */
export function passLines(pass: Pass, localContext: LocalContext, titleSuffix?: string): string[] {
  const title = localContext.paint("bold", pass.banner?.title ?? pass.title);
  if (titleSuffix !== undefined) return [`${title} · ${titleSuffix}`];
  return pass.nodes.length > 0 ? [title] : [];
}

/** A log's tail as the terminal shows it, within `maxCharacters` characters. */
export function tailLines(log: string[], maxCharacters = Infinity): string[] {
  const tail = log
    .slice(log.length <= FAILURE_FULL_LINES ? 0 : -FAILURE_TAIL_LINES)
    .map((line) => plainLine(line, SCROLLBACK_LINE_MAX_CHARS));
  while (tail.length > 0 && characterCountOf(tail) > maxCharacters) tail.shift();
  return tail;
}

/** A failure's log as its block shows it: its warnings print after the block. */
export const blockLog = (nodeState: FailedNodeState): string[] =>
  withoutWarnings(nodeState.log ?? []);

/** A failure: how it ended, its log's tail and error, then what to read, run and rerun. */
export function failureBlockLines(
  nodeState: FailedNodeState,
  run: RunState,
  localContext: LocalContext,
  tail = tailLines(blockLog(nodeState)),
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
  labelledRows.push(["rerun", rerunLine(localContext.rerunCommand, [name])]);
  const earlierLineCount = blockLog(nodeState).length - tail.length;
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
  if (failedNames.length > 0)
    lines.push(labelLine("rerun", rerunLine(localContext.rerunCommand, failedNames), localContext));
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

export function interruptedLines(run: RunState, localContext: LocalContext): string[] {
  const stoppedNames = selectors.nodesInFlight(run).map((nodeState) => nodeState.node.name);
  return [
    "",
    `${localContext.paint("gray", STATUS_ICON.cancelled)} forced exit${stoppedNames.length > 0 ? ` while ${stoppedNames.join(", ")} ran` : ""} · report ${localContext.link(localContext.failuresReportPath)}`,
  ];
}
