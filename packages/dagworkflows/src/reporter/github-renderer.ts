import type { NodeResult } from "@mrmeku/dagraph";
import type { CheckConclusion, CheckUpdate, Host } from "../host/index.ts";
import {
  STATUS_ICON,
  countsLine,
  failureMessage,
  formatDuration,
  groupLines,
  namesOf,
  reportHeadline,
  rerunLine,
  selectors,
  wallTimeOf,
  type NodeReport,
  type SettledNodeState,
} from "../kernel/index.ts";
import type { RunListener } from "../run-store/index.ts";

const isoTimestamp = (epochMs: number) => new Date(epochMs).toISOString();

/** How long a node took, or `not started` for one whose action did not run. */
function durationText(nodeState: SettledNodeState): string {
  const duration = selectors.durationOf(nodeState);
  return duration === undefined ? "not started" : formatDuration(duration);
}

/**
 * The run's last lines in the log, outside any group: what it came to, what failed or did not
 * run, and the command that reruns the failures (given `rerunCommand`, the command that ran it).
 */
function recapLines(title: string, nodes: NodeReport[], rerunCommand?: string): string[] {
  const failedNames = namesOf(nodes, "failed");
  const namesLine = (label: string, status: NodeResult["status"]) => {
    const names = namesOf(nodes, status);
    return names.length > 0 ? [`${label}: ${names.join(", ")}`] : [];
  };
  return [
    `${reportHeadline(nodes)} · ${title} · ${countsLine(nodes, String)} · wall ${formatDuration(wallTimeOf(nodes))}`,
    ...namesLine("failed", "failed"),
    ...namesLine("skipped, dependency failed", "dep-failed"),
    ...namesLine("cancelled", "cancelled"),
    ...(rerunCommand && failedNames.length > 0
      ? [`reproduce: ${rerunLine(rerunCommand, failedNames)}`]
      : []),
  ];
}

/**
 * The run drawn GitHub's way on any host: a line as a node starts and a group as it settles, so
 * logs never interleave, and a check run per node. The recap's reproduce line starts with
 * `rerunCommand` when given, else the pass's.
 */
export function githubRenderer(
  host: Host,
  opts: { rerunCommand?: string | undefined } = {},
): RunListener {
  // Check runs wait on the API, so they queue apart and never hold the log up.
  let checkRunQueue = Promise.resolve();
  const queueCheckRunUpdate = (update: CheckUpdate) => {
    checkRunQueue = checkRunQueue.then(() => host.check(update));
  };

  return {
    begin: ({ banner }) => {
      if (banner) host.group(banner.title, banner.lines);
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
      host.info(
        `▷ ${node.name}${lastRunDuration ? ` (last run ${formatDuration(lastRunDuration)})` : ""}`,
      );
    },
    settle: (nodeState, _run, log) => {
      const name = nodeState.node.name;
      const startedAt = selectors.startedAtOf(nodeState);
      const completeCheckRun = (conclusion: CheckConclusion, summary: string) =>
        queueCheckRunUpdate({
          name,
          status: "completed",
          conclusion,
          ...(startedAt !== undefined && { startedAt: isoTimestamp(startedAt) }),
          completedAt: isoTimestamp(nodeState.endedAt),
          summary,
        });
      switch (nodeState.status) {
        case "succeeded": {
          if (!nodeState.result.details.actionRan) {
            host.group(`${STATUS_ICON.succeeded} ${name} (cached)`, log);
            return completeCheckRun("success", "cached");
          }
          const duration = durationText(nodeState);
          host.group(`${STATUS_ICON.succeeded} ${name} (${duration})`, log);
          return completeCheckRun("success", `done in ${duration}`);
        }
        case "failed": {
          const message = failureMessage(nodeState);
          host.group(
            `${STATUS_ICON.failed} ${name} (${durationText(nodeState)})`,
            groupLines(nodeState, log),
          );
          host.annotate("error", name, message);
          return completeCheckRun(
            selectors.timedOut(nodeState.result) ? "timed_out" : "failure",
            message,
          );
        }
        case "dep-failed": {
          const message = failureMessage(nodeState);
          host.info(`${STATUS_ICON["dep-failed"]} ${name}: skipped, ${message}`);
          return completeCheckRun("skipped", message);
        }
        case "cancelled":
          if (selectors.actionRan(nodeState.result))
            host.group(`${STATUS_ICON.cancelled} ${name} (cancelled)`, log);
          else host.info(`${STATUS_ICON.cancelled} ${name}: cancelled`);
          return completeCheckRun("cancelled", "cancelled");
      }
    },
    finish: async (pass, nodes) => {
      // A post pass carries no command, and so draws no reproduce line.
      const rerunCommand = pass.rerunCommand && (opts.rerunCommand ?? pass.rerunCommand);
      for (const line of ["", ...recapLines(pass.title, nodes, rerunCommand)]) host.info(line);
      await checkRunQueue;
    },
  };
}
