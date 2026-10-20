import type { Result } from "@mrmeku/dagraph";
import { STATUS_ICON } from "../config.ts";
import { countsLine, formatDuration, groupLines, reportHeadline } from "../kernel/format.ts";
import { namesOf, rootFailures, wallTimeOf, type NodeReport } from "../kernel/report.ts";
import type { FailedNodeState, SettledNodeState, SucceededNodeState } from "../kernel/run-slice.ts";
import * as selectors from "../kernel/selectors.ts";
import { createRunStore, type RunListener } from "../kernel/store.ts";
import type { CheckConclusion, CheckUpdate, Ci, Ports } from "../ports.ts";

const CHECK_RUN_CONCLUSION_BY_STATUS: Record<Result["status"], CheckConclusion> = {
  done: "success",
  cached: "success",
  failed: "failure",
  "dep-failed": "skipped",
  cancelled: "cancelled",
};

const isoTimestamp = (epochMs: number) => new Date(epochMs).toISOString();

const durationText = (nodeState: SucceededNodeState | FailedNodeState) =>
  formatDuration(selectors.durationOf(nodeState));

function checkRunSummary(nodeState: SettledNodeState): string {
  switch (nodeState.status) {
    case "done":
      return `done in ${durationText(nodeState)}`;
    case "cached":
    case "cancelled":
      return nodeState.status;
    case "failed":
    case "dep-failed":
      return nodeState.error;
  }
}

/**
 * The run's last lines in the log, outside any group: what it came to, what failed or did not
 * run, and the command that reruns the failures' causes (given `rerunCommand`, the command that ran it).
 */
export function recapLines(title: string, nodes: NodeReport[], rerunCommand?: string): string[] {
  const rootFailureNames = rootFailures(nodes);
  const namesLine = (label: string, status: Result["status"]) => {
    const names = namesOf(nodes, status);
    return names.length > 0 ? [`${label}: ${names.join(", ")}`] : [];
  };
  return [
    `${reportHeadline(nodes)} · ${title} · ${countsLine(nodes, String)} · wall ${formatDuration(wallTimeOf(nodes))}`,
    ...namesLine("failed", "failed"),
    ...namesLine("skipped, dependency failed", "dep-failed"),
    ...namesLine("cancelled", "cancelled"),
    ...(rerunCommand && rootFailureNames.length > 0
      ? [`reproduce: ${rerunCommand} --only ${rootFailureNames.join(",")}`]
      : []),
  ];
}

/**
 * The renderer for github actions. Features a line with a node starts processing and a group
 * when it finishes to prevent interleaving of logs.
 */
export function createGithubRenderer(ci: Ci): RunListener {
  // Check runs wait on the API, so they queue apart and never hold the log up.
  let checkRunQueue = Promise.resolve();
  const queueCheckRunUpdate = (update: CheckUpdate) => {
    checkRunQueue = checkRunQueue.then(() => ci.check(update));
  };

  const drawSettledNode = (nodeState: SettledNodeState, log: string[]) => {
    const name = nodeState.node.name;
    switch (nodeState.status) {
      case "done":
        ci.group(`${STATUS_ICON.done} ${name} (${durationText(nodeState)})`, log);
        break;
      case "cached":
        ci.group(`${STATUS_ICON.cached} ${name} (cached)`, log);
        break;
      case "failed":
        ci.group(
          `${STATUS_ICON.failed} ${name} (${durationText(nodeState)})`,
          groupLines(nodeState, log),
        );
        ci.annotate("error", name, nodeState.error);
        break;
      case "dep-failed":
        ci.info(`${STATUS_ICON["dep-failed"]} ${name}: skipped, ${nodeState.error}`);
        break;
      case "cancelled":
        // A node the cancel interrupted shows what it printed before it stopped.
        if (nodeState.actionKey) ci.group(`${STATUS_ICON.cancelled} ${name} (cancelled)`, log);
        else ci.info(`${STATUS_ICON.cancelled} ${name}: cancelled`);
    }
  };

  return {
    begin: ({ banner }) => {
      if (banner) ci.group(banner.title, banner.lines);
    },
    immediate: {
      start: (nodeState) =>
        queueCheckRunUpdate({
          name: nodeState.node.name,
          status: "in_progress",
          startedAt: isoTimestamp(nodeState.startedAt),
        }),
    },
    start: ({ node }, run) => {
      const lastRunDuration = run.lastRunDurations?.[node.name];
      ci.info(
        `▷ ${node.name}${lastRunDuration ? ` (last run ${formatDuration(lastRunDuration)})` : ""}`,
      );
    },
    settle: (nodeState, _run, log) => {
      drawSettledNode(nodeState, log);
      const startedAt = selectors.startedAtOf(nodeState);
      queueCheckRunUpdate({
        name: nodeState.node.name,
        status: "completed",
        conclusion:
          nodeState.status === "failed" && nodeState.timedOut
            ? "timed_out"
            : CHECK_RUN_CONCLUSION_BY_STATUS[nodeState.status],
        ...(startedAt !== undefined && { startedAt: isoTimestamp(startedAt) }),
        completedAt: isoTimestamp(nodeState.endedAt),
        summary: checkRunSummary(nodeState),
      });
    },
    finish: async (pass, nodes) => {
      for (const line of ["", ...recapLines(pass.title, nodes, pass.rerunCommand)]) ci.info(line);
      await checkRunQueue;
    },
  };
}

export const createGithubStore = (ports: Pick<Ports, "ci" | "fs" | "clock">, casBaseDir: string) =>
  createRunStore({
    fs: ports.fs,
    clock: ports.clock,
    casBaseDir,
    listeners: [createGithubRenderer(ports.ci)],
  });
