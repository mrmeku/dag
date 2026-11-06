import { countResultsByStatus, type NodeResult } from "@mrmeku/dagraph";
import { stripVTControlCharacters } from "node:util";
import { namesOf, type NodeReport } from "./report.ts";
import type { FailureNodeState, NodeState, RunState } from "./run-slice.ts";
import { nodeReports, timedOut } from "./selectors.ts";

/**
 * A node's status as an icon, in log group titles, the summary and the DAG's labels: Nx's
 * terminal set (figures' tick and cross; its TUI's skipped and stopped), where a cache hit is a
 * success and the word "cached" says the rest. U+FE0E keeps a browser from drawing an emoji.
 */
export const STATUS_ICON: Record<NodeResult["status"], string> = {
  succeeded: "✔\uFE0E",
  failed: "✖\uFE0E",
  "dep-failed": "⏭\uFE0E",
  cancelled: "◼\uFE0E",
};

const CONTROL_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/** A node's own timeout in the words of GitHub's runner. */
function timeoutMessage(name: string, timeoutMs: number): string {
  const minutes = +(timeoutMs / 60_000).toFixed(2);
  const after =
    timeoutMs >= 60_000
      ? `${minutes} minute${minutes === 1 ? "" : "s"}`
      : formatDuration(timeoutMs);
  return `The action '${name}' has timed out after ${after}.`;
}

/**
 * What every output says of a failure: its error's message, or its own timeout's in the words of
 * GitHub's runner; or why a skipped node did not run: a required dep did not succeed. A renderer
 * calls it with a report's `node` and `result` once the result is failed or dep-failed.
 */
export function failureMessage({
  node,
  result,
}: Pick<FailureNodeState, "node" | "result">): string {
  switch (result.status) {
    case "failed":
      return timedOut(result) && node.timeoutMs !== undefined
        ? timeoutMessage(node.name, node.timeoutMs)
        : result.error.message;
    case "dep-failed":
      return `dependency ${result.dep} failed`;
  }
}

/** What a run is called where its output needs a name: its workflow file. */
export const titleOf = (workflowFile: string | undefined): string => workflowFile ?? "run";

/** A log's lines as its group counts them: trailing blank lines and whitespace dropped. */
export function logLines(text: string): string[] {
  const trimmed = text.trimEnd();
  return trimmed ? trimmed.split("\n") : [];
}

export const textOf = (lines: string[]): string => lines.map((line) => `${line}\n`).join("");

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

const cancelledHeadline = (notRunCount: number): string =>
  `${STATUS_ICON.cancelled} cancelled, ${plural(notRunCount, "node")} not run`;

/**
 * A word as a POSIX shell reads it back, by `shlex.quote`'s rules: bare when every character is
 * safe, else single-quoted, each run of quotes double-quoted between.
 */
function shellWord(word: string): string {
  if (word === "") return "''";
  if (!/[^\w@%+=:,./-]/.test(word)) return word;
  return `'${word.replace(/'+/g, (run) => `'"${run}"'`)}'`.replace(/^''|''$/g, "");
}

/** The `--only` argument naming `nodeNames`, quoted when a shell needs it: `--only 'lint docs'`. */
export const onlyArgument = (nodeNames: string[]): string =>
  `--only ${shellWord(nodeNames.join(","))}`;

/** The command that reruns `nodeNames`: `npx --no dag run ci.ts --only 'lint docs'`. */
export const rerunLine = (rerunCommand: string, nodeNames: string[]): string =>
  `${rerunCommand} ${onlyArgument(nodeNames)}`;

/**
 * What a run's banner says it runs: `3 nodes`, `1 node`, or under `--only`
 * `2 of 5 nodes (--only lint,test)`.
 */
export const scopeOf = (total: number, only: string[] | undefined, selected: number): string =>
  only?.length
    ? `${selected} of ${plural(total, "node")} (--only ${only.join(",")})`
    : plural(total, "node");

/** What the run came to, in a few words. */
export function reportHeadline(nodes: NodeReport[]): string {
  const failureNames = namesOf(nodes, "failed");
  const skippedCount = namesOf(nodes, "dep-failed").length;
  const cancelledCount = namesOf(nodes, "cancelled").length;
  if (failureNames.length > 3)
    return `${STATUS_ICON.failed} ${failureNames.slice(0, 3).join(", ")} and ${failureNames.length - 3} more failed`;
  if (failureNames.length > 0) return `${STATUS_ICON.failed} ${failureNames.join(", ")} failed`;
  if (skippedCount > 0)
    return `${STATUS_ICON["dep-failed"]} ${plural(skippedCount, "node")} skipped, a dependency failed`;
  if (cancelledCount > 0) return cancelledHeadline(cancelledCount);
  return `${STATUS_ICON.succeeded} ${nodes.length === 1 ? "1 node" : `all ${nodes.length} nodes`} succeeded`;
}

export function countsLine(nodes: NodeReport[], formatCount: (count: number) => string): string {
  const counts = countResultsByStatus(nodes.map(({ result }) => result));
  const built = nodes.filter(
    ({ result }) => result.status === "succeeded" && result.details.actionRan,
  ).length;
  return `built ${formatCount(built)} · cached ${formatCount(counts.succeeded - built)} · failed ${formatCount(counts.failed)} · skipped ${formatCount(counts["dep-failed"])}${counts.cancelled > 0 ? ` · cancelled ${formatCount(counts.cancelled)}` : ""}`;
}

/** A node's log as its group prints it: the log, then a failure's error; a skipped node's message. */
export function groupLines(nodeState: NodeState, log: string[]): string[] {
  switch (nodeState.status) {
    case "failed":
      return [...log, "── error ──", ...logLines(failureMessage(nodeState))];
    case "dep-failed":
      return [failureMessage(nodeState)];
    default:
      return log;
  }
}

/** That the run errored, its failures, that it was cancelled, or else what it came to. */
export function runHeadline(run: RunState): string {
  switch (run.lifecycle.status) {
    case "errored":
      return `${STATUS_ICON.failed} errored: ${logLines(run.lifecycle.error)[0] ?? ""}`;
    case "cancelling":
    case "cancelled": {
      const reports = nodeReports(run);
      return namesOf(reports, "failed").length > 0
        ? reportHeadline(reports)
        : cancelledHeadline(
            namesOf(reports, "cancelled").length + namesOf(reports, "dep-failed").length,
          );
    }
    default:
      return reportHeadline(nodeReports(run));
  }
}
