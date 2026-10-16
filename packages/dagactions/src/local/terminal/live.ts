import type { ThrottledSchedulerOptions } from "@mrmeku/dagraph";
import stringWidth from "string-width";
import {
  LIVE_FALLBACK_SIZE,
  LIVE_FIRST_DRAW_MS,
  LIVE_FRAME_MS,
  LIVE_LATEST_LINE_GAP,
  LIVE_LATEST_LINE_MAX_CHARS,
  LIVE_LATEST_LINE_MIN_COLUMNS,
  LIVE_MAX_COLUMNS,
  LIVE_MAX_ROWS,
  LIVE_MIN_COLUMNS,
  LIVE_WAITING_ROWS,
  LIVE_WAITS_ON_SHOWN,
  SPINNER_FRAMES,
  STATUS_ICON,
} from "../../config.ts";
import { isDebugCommand, plainLine } from "../../kernel/format.ts";
import type {
  InFlightNodeState,
  NodeState,
  RunState,
  SettledNodeState,
} from "../../kernel/run-slice.ts";
import * as selectors from "../../kernel/selectors.ts";
import type { RunListener } from "../../kernel/store.ts";
import type { Clock } from "../../ports.ts";
import { clockOf, detailOf, type LocalContext, type Paint } from "../words.ts";
import {
  failureBlockLines,
  interruptedLines,
  nameWidth,
  padName,
  passLines,
  recapLines,
} from "./blocks.ts";
import { createFrame, type WriteStreams } from "./frame.ts";

type SchedulerLimits = ThrottledSchedulerOptions | undefined;

const graphemeSegmenter = new Intl.Segmenter();

/** `text` in at most `maxColumns` columns, an ellipsis ending what was cut; it stops measuring there. */
export function truncate(text: string, maxColumns: number): string {
  let usedColumns = 0;
  let cutIndex = 0;
  for (const { segment, index } of graphemeSegmenter.segment(text)) {
    usedColumns += stringWidth(segment);
    if (usedColumns > maxColumns) return `${text.slice(0, cutIndex)}…`;
    if (usedColumns < maxColumns) cutIndex = index + segment.length;
  }
  return text;
}

const STATUS_COLOR = {
  done: "green",
  fail: "red",
  "dep-failed": "yellow",
  cancelled: "gray",
} as const;

const withCauses = (run: RunState, nodeState: NodeState, description: string): string => {
  const causes = selectors.causesOf(run, nodeState);
  return causes.length > 0 ? `${description} (because ${causes.join(", ")} failed)` : description;
};

/** A settled node as the scrollback keeps it: a line, an own failure's block, or nothing. */
function settledNodeLines(
  nodeState: SettledNodeState,
  run: RunState,
  localContext: LocalContext,
): string[] {
  if (nodeState.status === "cached" || (nodeState.status === "cancelled" && !nodeState.actionKey))
    return [];
  if (selectors.isOwnFailure(run, nodeState))
    return failureBlockLines(nodeState, run, localContext);
  const detail = {
    done: () => detailOf(nodeState),
    fail: () => withCauses(run, nodeState, "failed"),
    "dep-failed": () => withCauses(run, nodeState, "skipped"),
    cancelled: () => {
      const duration = selectors.durationOf(nodeState);
      return duration === undefined ? "cancelled" : `cancelled after ${clockOf(duration)}`;
    },
  }[nodeState.status]();
  const paddedName = padName(nodeState.node.name, nameWidth(run.nodes.keys()));
  return [
    `${localContext.paint(STATUS_COLOR[nodeState.status], STATUS_ICON[nodeState.status])} ${paddedName} ${localContext.paint("dim", detail)}`,
  ];
}

/** Why a pending node waits: on its deps, or queued behind its concurrency group or the limit. */
function waitReasonOf(
  run: RunState,
  nodeState: NodeState,
  inFlightNodes: NodeState[],
  limits: SchedulerLimits,
) {
  const pendingDeps = nodeState.node.deps.filter((dep) => {
    const depState = run.nodes.get(dep);
    return depState !== undefined && !selectors.isSettled(depState);
  });
  if (pendingDeps.length > 0) {
    const moreSuffix =
      pendingDeps.length > LIVE_WAITS_ON_SHOWN
        ? ` +${pendingDeps.length - LIVE_WAITS_ON_SHOWN}`
        : "";
    return {
      queued: false,
      reason: `waits on ${pendingDeps.slice(0, LIVE_WAITS_ON_SHOWN).join(", ")}${moreSuffix}`,
    };
  }
  const concurrencyGroup = nodeState.node.concurrencyGroup;
  const groupLimit = concurrencyGroup && limits?.concurrencyLimits?.[concurrencyGroup];
  if (concurrencyGroup && groupLimit) {
    const runningInGroup = inFlightNodes.filter(
      (inFlightNode) => inFlightNode.node.concurrencyGroup === concurrencyGroup,
    ).length;
    return { queued: true, reason: `queued: ${concurrencyGroup} ${runningInGroup}/${groupLimit}` };
  }
  return {
    queued: true,
    reason: `queued: ${inFlightNodes.length}/${limits?.maxParallelism ?? "∞"} running`,
  };
}

/** What a node in flight says: the line it is printing, else the last line with text it ended. */
function latestLineOf(nodeState: NodeState): string {
  // The unfinished line holds no carriage return but a trailing one, so its head is all that can show.
  const printing = plainLine(
    nodeState.unfinishedLine.slice(0, 2 * LIVE_LATEST_LINE_MAX_CHARS),
    LIVE_LATEST_LINE_MAX_CHARS,
  );
  const latestLine =
    printing.trim() && !isDebugCommand(printing)
      ? printing
      : nodeState.lastLine.slice(0, LIVE_LATEST_LINE_MAX_CHARS);
  // Format characters and tabs take columns a terminal and string-width disagree on.
  return latestLine.replace(/\p{Cf}/gu, "").replaceAll("\t", " ");
}

/** The nodes in flight, a few waiting and why, and the status row: the one place a name is cut. */
function footerRows(
  run: RunState,
  view: {
    now: number;
    columns: number;
    rows: number;
    limits: SchedulerLimits;
    paint: Paint;
  },
): string[] {
  const { now, paint } = view;
  const footerWidth = Math.max(LIVE_MIN_COLUMNS, Math.min(view.columns - 1, LIVE_MAX_COLUMNS));
  const nodeRowsRoom = Math.max(0, Math.min(LIVE_MAX_ROWS, Math.floor(view.rows / 2)) - 1);
  const inFlightNodes = selectors.nodesInFlight(run);
  const waitingNodes = [...run.nodes.values()]
    .filter((nodeState) => nodeState.status === "pending")
    .map((nodeState) => ({
      nodeState,
      ...waitReasonOf(run, nodeState, inFlightNodes, view.limits),
    }))
    .sort((left, right) => Number(right.queued) - Number(left.queued));
  const nameColumns = nameWidth(
    [...inFlightNodes, ...waitingNodes.map((waitingNode) => waitingNode.nodeState)].map(
      (nodeState) => nodeState.node.name,
    ),
  );
  const paddedNameOf = (nodeState: NodeState) =>
    padName(truncate(nodeState.node.name, nameColumns), nameColumns);
  const spinnerFrame = SPINNER_FRAMES[Math.floor(now / LIVE_FRAME_MS) % SPINNER_FRAMES.length]!;
  const inFlightRow = (nodeState: InFlightNodeState) => {
    const lastRunDuration = run.lastRunDurations?.[nodeState.node.name];
    const rowHead = truncate(
      `${spinnerFrame} ${paddedNameOf(nodeState)} ${clockOf(now - nodeState.dispatchedAt)}${lastRunDuration ? ` / ~${clockOf(lastRunDuration)}` : ""}`,
      footerWidth,
    );
    const latestLineColumns = footerWidth - stringWidth(rowHead) - LIVE_LATEST_LINE_GAP;
    const latestLine =
      nodeState.status === "dispatched" ? "checking cache" : latestLineOf(nodeState);
    const latestLineCell =
      latestLineColumns >= LIVE_LATEST_LINE_MIN_COLUMNS && latestLine
        ? `${" ".repeat(LIVE_LATEST_LINE_GAP)}${paint("dim", truncate(latestLine, latestLineColumns))}`
        : "";
    return `${paint("cyan", spinnerFrame)}${rowHead.slice(spinnerFrame.length)}${latestLineCell}`;
  };

  const shownInFlight =
    inFlightNodes.length <= nodeRowsRoom
      ? inFlightNodes
      : inFlightNodes.slice(0, Math.max(0, nodeRowsRoom - 1));
  const bodyRows = shownInFlight.map(inFlightRow);
  if (shownInFlight.length < inFlightNodes.length && nodeRowsRoom > 0)
    bodyRows.push(paint("dim", `  +${inFlightNodes.length - shownInFlight.length} more running`));
  for (const { nodeState, reason } of waitingNodes.slice(
    0,
    Math.min(LIVE_WAITING_ROWS, nodeRowsRoom - bodyRows.length),
  ))
    bodyRows.push(paint("dim", truncate(`· ${paddedNameOf(nodeState)} ${reason}`, footerWidth)));

  const allNodes = [...run.nodes.values()];
  const failedCount = allNodes.filter((nodeState) => nodeState.status === "fail").length;
  const progress = `[${allNodes.filter(selectors.isSettled).length}/${allNodes.length}${failedCount > 0 ? ` ${STATUS_ICON.fail}${failedCount}` : ""}]`;
  const queuedCount = waitingNodes.filter((waitingNode) => waitingNode.queued).length;
  const statusText =
    run.lifecycle.status === "cancelling"
      ? `cancelling: waiting for ${inFlightNodes.length} running · ctrl-c again to force`
      : `${inFlightNodes.length} running${queuedCount > 0 ? ` · ${queuedCount} queued` : ""} · ctrl-c cancels`;
  return [...bodyRows, truncate(`${progress} ${statusText}`, footerWidth)];
}

/**
 * The `live` style, a person's: settled nodes into the scrollback, cache hits gathered in one
 * line, and under them a footer redrawn from `getState` every LIVE_FRAME_MS once the run is
 * LIVE_FIRST_DRAW_MS old.
 */
export function createLiveRenderer(
  localContext: LocalContext,
  streams: WriteStreams,
  clock: Clock,
  limits: SchedulerLimits,
  getState: () => RunState,
) {
  let frame: ReturnType<typeof createFrame> | undefined;
  // Made at the run's first line, so the workflow body's own prints pass straight through.
  const currentFrame = () => (frame ??= createFrame(streams));
  const cachedNames: string[] = [];
  let redrawTimer: ReturnType<typeof setInterval> | undefined;
  const printLines = (lines: string[]) => {
    const cacheHitNames = cachedNames.splice(0);
    const cacheHitLine = `${localContext.paint("green", STATUS_ICON.cached)} ${localContext.paint("dim", "cached:")} ${cacheHitNames.join(", ")}`;
    currentFrame().print(cacheHitNames.length > 0 ? [cacheHitLine, ...lines] : lines);
  };
  const drawFooter = () => {
    const run = getState();
    printLines([]);
    const now = clock.now();
    const startedAt = selectors.runStartedAt(run);
    const { columns = LIVE_FALLBACK_SIZE.columns, rows = LIVE_FALLBACK_SIZE.rows } = streams.stdout;
    const footerShown = startedAt !== undefined && now - startedAt >= LIVE_FIRST_DRAW_MS;
    currentFrame().draw(
      footerShown ? footerRows(run, { now, columns, rows, limits, paint: localContext.paint }) : [],
    );
  };
  const endFooter = (lines: string[]) => {
    clearInterval(redrawTimer);
    printLines(lines);
    currentFrame().draw([]);
    currentFrame().restore();
  };

  return {
    begin: (pass, _run, isFirstPass) => {
      printLines(
        passLines(
          pass,
          localContext,
          isFirstPass ? `logs ${localContext.link(localContext.logDir)}/` : undefined,
        ),
      );
      if (isFirstPass) redrawTimer = setInterval(drawFooter, LIVE_FRAME_MS).unref();
    },
    settle: (nodeState, run) => {
      if (nodeState.status === "cached") cachedNames.push(nodeState.node.name);
      else printLines(settledNodeLines(nodeState, run, localContext));
    },
    close: (run) =>
      endFooter(recapLines(run, localContext, { hint: "   (hand this to an agent)" })),
    interrupt: (run) => endFooter(interruptedLines(run, localContext)),
    printLine: (line: string) => printLines([line]),
  } satisfies RunListener & { printLine: (line: string) => void };
}
