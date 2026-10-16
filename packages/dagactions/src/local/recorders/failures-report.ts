import { join } from "shlex";
import { FAILURES_REPORT_LOG_LINES, STATUS_ICON } from "../../config.ts";
import { logLines, plainLine, plural, textOf, titleOf } from "../../kernel/format.ts";
import type { RunState } from "../../kernel/run-slice.ts";
import * as selectors from "../../kernel/selectors.ts";
import type { RunListener } from "../../kernel/store.ts";
import type { SyncFs } from "../../ports.ts";
import {
  clockOf,
  detailOf,
  errorSaysOnlyExitCode,
  rerunLine,
  runHeadline,
  tallyOf,
  type LocalContext,
} from "../words.ts";
import { createWriter } from "./writer.ts";

const longestBacktickRun = (text: string): number =>
  Math.max(0, ...(text.match(/`+/g) ?? []).map((backtickRun) => backtickRun.length));

/** `text` as inline code that no backtick in it ends. */
function inlineCode(text: string): string {
  const backticks = "`".repeat(longestBacktickRun(text) + 1);
  const padding = backticks.length > 1 ? " " : "";
  return `${backticks}${padding}${text}${padding}${backticks}`;
}

function fencedBlock(lines: string[]): string[] {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(lines.join("\n")) + 1));
  return [`${fence}text`, ...lines, fence];
}

/** failures.md's head: the run's status and, once the run has ended, what it came to. */
function statusLines(run: RunState, hasFailures: boolean): string[] {
  const { lifecycle } = run;
  const tally = tallyOf(run);
  const startedAt = selectors.runStartedAt(run);
  const statusLine = (withWallTime: boolean) =>
    [
      `status: ${lifecycle.status}`,
      ...(startedAt !== undefined ? [`started ${new Date(startedAt).toISOString()}`] : []),
      ...(withWallTime && tally ? [`wall ${clockOf(tally.wallTime)}`] : []),
    ].join(" · ");
  const outcomeLine = [runHeadline(run), ...(tally ? [tally.countsLine] : [])].join(" · ");
  const noFailures = (text: string) => (hasFailures ? [] : [text, ""]);
  switch (lifecycle.status) {
    case "running":
    case "cancelling":
      return [statusLine(false), "", ...noFailures("No failures so far.")];
    case "finished":
    case "cancelled":
      return [statusLine(true), ...(tally ? [outcomeLine] : []), "", ...noFailures("No failures.")];
    case "errored":
      return [statusLine(true), outcomeLine, "", ...fencedBlock(logLines(lifecycle.error)), ""];
    case "interrupted": {
      // A forced exit's in-flight nodes have no end, so no wall time counts them.
      const stoppedNames = selectors
        .nodesInFlight(run)
        .map((nodeState) => inlineCode(nodeState.node.name));
      const stopped = stoppedNames.length > 0 ? ` while ${stoppedNames.join(", ")} ran` : "";
      return [
        statusLine(false),
        ...(tally ? [outcomeLine] : []),
        "",
        `A forced exit stopped the run${stopped}.`,
        "",
        ...noFailures("No failures."),
      ];
    }
  }
}

/** failures.md: the run's status and outcome, then each own failure and what it takes to fix. */
function failuresReportMarkdown(run: RunState, localContext: LocalContext): string {
  const ownFailures = selectors.ownFailures(run);
  const markdownLines = [
    `# Failures · ${titleOf(localContext.workflowFile)}`,
    "",
    ...statusLines(run, ownFailures.length > 0),
  ];
  for (const nodeState of ownFailures) {
    const name = nodeState.node.name;
    const { failed, skipped } = selectors.consequencesOf(run, name);
    const alsoFailedDeps = selectors.failedDepsOf(run, nodeState);
    const logFile = localContext.logFile(name);
    const logTail = (nodeState.log ?? [])
      .slice(-FAILURES_REPORT_LOG_LINES)
      .map((line) => plainLine(line));
    const inlineCodeList = (names: string[]) => names.map(inlineCode).join(", ");
    // Its own error too: a node that ran no command may also have failed for a reason of its own.
    const nameWithError = (name: string) => {
      const consequence = run.nodes.get(name);
      const error = consequence?.status === "fail" ? consequence.error : "";
      return `${inlineCode(name)} (${logLines(error)[0] ?? "failed"})`;
    };
    markdownLines.push(
      `## ${STATUS_ICON.fail} ${name} · ${detailOf(nodeState)}`,
      "",
      ...(nodeState.command
        ? [
            `- command: ${inlineCode(join(nodeState.command.argv))} (cwd ${inlineCode(nodeState.command.cwd)})`,
          ]
        : []),
      ...(errorSaysOnlyExitCode(nodeState)
        ? []
        : [`- error: ${logLines(nodeState.error).join(" ")}`]),
      ...(logFile
        ? [`- log: ${inlineCode(logFile)} (${plural(nodeState.lineCount ?? 0, "line")})`]
        : []),
      ...(alsoFailedDeps.length > 0
        ? [`- dependencies that also failed: ${inlineCodeList(alsoFailedDeps)}`]
        : []),
      ...(failed.length > 0
        ? [`- failed because of it: ${failed.map(nameWithError).join(", ")}`]
        : []),
      ...(skipped.length > 0 ? [`- skipped because of it: ${inlineCodeList(skipped)}`] : []),
      `- rerun: ${inlineCode(rerunLine(localContext.rerunCommand, [name]))}`,
      "",
      ...(logTail.length > 0 ? [...fencedBlock(logTail), ""] : []),
    );
  }
  markdownLines.push(`Logs: ${localContext.logDir}/ · summary: ${localContext.summaryPath}`);
  return textOf(markdownLines);
}

/** failures.md, written as each pass begins, as nodes fail, as the run ends and at a forced exit. */
export function createFailuresReport(
  localContext: LocalContext,
  fs: SyncFs,
  warn: (message: string) => void,
) {
  const writeFile = createWriter(fs, warn, "failures report");
  const writeReport = (run: RunState) =>
    writeFile(localContext.failuresReportPath, failuresReportMarkdown(run, localContext));
  return {
    begin: (_pass, run) => writeReport(run),
    settle: (nodeState, run) => {
      if (nodeState.status === "fail" || nodeState.status === "dep-failed") writeReport(run);
    },
    close: writeReport,
    interrupt: writeReport,
  } satisfies RunListener;
}
