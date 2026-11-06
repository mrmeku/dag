import { errorMessage } from "@mrmeku/dagraph";
import { dirname } from "node:path";
import { join } from "shlex";
import { FAILURE_LOG_TAIL_LINES } from "../../config/index.ts";
import type { Host } from "../../host/index.ts";
import {
  STATUS_ICON,
  failureMessage,
  logLines,
  plainLine,
  plural,
  rerunLine,
  runHeadline,
  selectors,
  textOf,
  titleOf,
  type RunState,
} from "../../kernel/index.ts";
import type { RunListener } from "../../run-store/index.ts";
import type { SyncFileSystem } from "../../wiring/index.ts";
import {
  clockOf,
  detailOf,
  errorSaysOnlyExitCode,
  localRerunCommand,
  tallyOf,
  type LocalFiles,
} from "../words/index.ts";

/**
 * A listener's writes, synchronous so its files are whole when the process is forced out. The
 * first that fails warns on the host, and the writes stop there: a full disk never stops the run.
 */
function createWriter(syncFs: SyncFileSystem, host: Host, listenerName: string) {
  const madeDirectories = new Set<string>();
  let disabled = false;
  return (path: string, text: string) => {
    if (disabled) return;
    try {
      if (!madeDirectories.has(dirname(path))) syncFs.mkdirSync(dirname(path), { recursive: true });
      madeDirectories.add(dirname(path));
      syncFs.writeFileSync(path, text);
    } catch (e) {
      disabled = true;
      host.annotate("warning", "dag", `${listenerName} off: ${errorMessage(e)}`);
    }
  };
}

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

/** failures.md: the run's status and outcome, then each failure and what it takes to fix. */
function failuresReportMarkdown(run: RunState, files: LocalFiles): string {
  const rerunCommand = localRerunCommand(files.workflowFile);
  const failures = selectors.failedNodes(run);
  const markdownLines = [
    `# Failures · ${titleOf(files.workflowFile)}`,
    "",
    ...statusLines(run, failures.length > 0),
  ];
  for (const nodeState of failures) {
    const name = nodeState.node.name;
    const skipped = selectors.skippedBecauseOf(run, name);
    const alsoFailedDeps = selectors
      .getDependencyFailures(run, nodeState)
      .map((depState) => depState.node.name);
    const logFile = files.logFile(name);
    const logTail = (nodeState.log ?? [])
      .slice(-FAILURE_LOG_TAIL_LINES)
      .map((line) => plainLine(line));
    const inlineCodeList = (names: string[]) => names.map(inlineCode).join(", ");
    const command = selectors.commandOf(nodeState.result.error);
    markdownLines.push(
      `## ${STATUS_ICON.failed} ${name} · ${detailOf(nodeState)}`,
      "",
      ...(command
        ? [`- command: ${inlineCode(join(command.argv))} (cwd ${inlineCode(command.cwd)})`]
        : []),
      ...(errorSaysOnlyExitCode(nodeState)
        ? []
        : [`- error: ${logLines(failureMessage(nodeState)).join(" ")}`]),
      ...(logFile
        ? [`- log: ${inlineCode(logFile)} (${plural(nodeState.lineCount ?? 0, "line")})`]
        : []),
      ...(alsoFailedDeps.length > 0
        ? [`- dependencies that also failed: ${inlineCodeList(alsoFailedDeps)}`]
        : []),
      ...(skipped.length > 0 ? [`- skipped because of it: ${inlineCodeList(skipped)}`] : []),
      ...(rerunCommand ? [`- rerun: ${inlineCode(rerunLine(rerunCommand, [name]))}`] : []),
      "",
      ...(logTail.length > 0 ? [...fencedBlock(logTail), ""] : []),
    );
  }
  markdownLines.push(`Logs: ${files.logDir}/ · summary: ${files.summaryPath}`);
  return textOf(markdownLines);
}

/**
 * failures.md, written as each pass begins, as nodes fail or are skipped, as the run ends and at a
 * forced exit.
 */
export function createFailuresReport(files: LocalFiles, syncFs: SyncFileSystem, host: Host) {
  const writeFile = createWriter(syncFs, host, "failures report");
  const writeReport = (run: RunState) =>
    writeFile(files.failuresReportPath, failuresReportMarkdown(run, files));
  return {
    begin: (_pass, run) => writeReport(run),
    settle: (nodeState, run) => {
      if (nodeState.status === "failed" || nodeState.status === "dep-failed") writeReport(run);
    },
    close: writeReport,
    interrupt: writeReport,
  } satisfies RunListener;
}
