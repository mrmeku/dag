import { outputDirFor, type ExecEvent, type ExecResult, type Node } from "@mrmeku/dagraph";
import { LAST_RUN_FILE, STATUS_ICON } from "./config.ts";
import type { CheckConclusion, CheckUpdate, Ports } from "./ports.ts";
import { logPath } from "./steps.ts";
import {
  DEFAULT_SUMMARY_RENDERERS,
  footer,
  formatDuration,
  renderSummary,
  type NodeReport,
  type SummaryRenderer,
} from "./summary.ts";

type Settled = Extract<
  ExecEvent,
  { type: "done" | "cached" | "fail" | "dep-failed" | "cancelled" }
>;
type Status = ExecResult["status"];

interface Timing {
  start: number;
  end: number;
}

interface LastRun {
  durations: Record<string, number>;
}

const CONCLUSION: Record<Status, CheckConclusion> = {
  done: "success",
  cached: "success",
  fail: "failure",
  "dep-failed": "skipped",
  cancelled: "cancelled",
};

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && e.name === "TimeoutError";
}

/** A failure's message; a timeout in the words of GitHub's runner. */
function failureText(node: Node | undefined, e: unknown): string {
  if (!isTimeout(e) || node?.timeoutMs === undefined) return errorText(e);
  const minutes = node.timeoutMs / 60_000;
  const after =
    minutes >= 1
      ? `${+minutes.toFixed(2)} minute${minutes === 1 ? "" : "s"}`
      : formatDuration(node.timeoutMs);
  return `The action '${node.name}' has timed out after ${after}.`;
}

function lines(text: string): string[] {
  const t = text.trimEnd();
  return t ? t.split("\n") : [];
}

/**
 * Turns dagraph's event stream into CI output: a line when a node's action starts, with its
 * duration in the last run; a live check per node (in_progress when its action starts, completed
 * at settle); one collapsible group per node that ran, emitted when it settles so concurrent
 * nodes never interleave; a plain line for a node that did not run; an annotation per failure;
 * a markdown summary drawn by the renderers in `summary` (summary.ts); and a closing recap in
 * the log. `rerun` is the command that ran this workflow, for the recap's reproduce line. Logs
 * are read back from the CAS, which is why cached and failed nodes still show their output.
 */
export function createReporter(
  ports: Ports,
  opts: {
    casBaseDir: string;
    nodes: Node[];
    title?: string;
    rerun?: string;
    summary?: readonly SummaryRenderer[];
  },
) {
  const started = new Map<string, number>();
  const timing = new Map<string, Timing>();
  const durations: Record<string, number> = {};
  // The log keeps event order. Check runs wait on the API, so they queue apart and never hold it up.
  let logs = Promise.resolve();
  let checks = Promise.resolve();
  const queueLog = (work: () => Promise<void>) => {
    logs = logs.then(work);
  };
  const queueCheck = (update: CheckUpdate) => {
    checks = checks.then(() => ports.ci.check(update));
  };

  const logLines = async (actionKey: string): Promise<string[]> => {
    const path = logPath(outputDirFor(opts.casBaseDir, actionKey));
    if (!actionKey || !(await ports.fs.exists(path))) return [];
    const all = lines(await ports.fs.readText(path));
    // A tool's own `::debug::` commands (the toolkit's globber writes one per file) are for the
    // runner's debug mode alone; the group, the check and the summary show the log without them.
    return all.filter((l) => !l.startsWith("::debug::"));
  };

  const failureBody = (log: string[], message: string): string[] => [
    ...log,
    "── error ──",
    ...lines(message),
  ];

  const settle = async (ev: Settled, end: number) => {
    const name = ev.node.name;
    const start = started.get(name);
    if (start !== undefined) timing.set(name, { start, end: Math.max(end, start + 1) });
    if (start !== undefined && (ev.type === "done" || ev.type === "fail")) {
      durations[name] = timing.get(name)!.end - start;
      await writeLastRun();
    }
    const dur = start !== undefined ? formatDuration(end - start) : "";
    let summary: string;
    let body: string[];
    let conclusion = CONCLUSION[ev.type];
    switch (ev.type) {
      case "done":
        body = await logLines(ev.actionKey);
        ports.ci.group(`${STATUS_ICON.done} ${name} (${dur})`, body);
        summary = `done in ${dur}`;
        break;
      case "cached":
        body = await logLines(ev.actionKey);
        ports.ci.group(`${STATUS_ICON.cached} ${name} (cached)`, body);
        summary = "cached";
        break;
      case "fail": {
        const message = failureText(ev.node, ev.error);
        if (isTimeout(ev.error)) conclusion = "timed_out";
        const log = await logLines(ev.actionKey);
        body = failureBody(log, message);
        ports.ci.group(`${STATUS_ICON.fail} ${name} (${dur})`, body);
        ports.ci.annotate("error", name, message);
        summary = message;
        break;
      }
      case "dep-failed":
        summary = errorText(ev.error);
        body = [];
        ports.ci.info(`${STATUS_ICON["dep-failed"]} ${name}: skipped, ${summary}`);
        break;
      case "cancelled":
        summary = "cancelled";
        // A node the cancel interrupted shows what it printed before it stopped.
        body = await logLines(ev.actionKey);
        if (ev.actionKey) ports.ci.group(`${STATUS_ICON.cancelled} ${name} (cancelled)`, body);
        else ports.ci.info(`${STATUS_ICON.cancelled} ${name}: cancelled`);
        break;
    }
    queueCheck({
      name,
      status: "completed",
      conclusion,
      ...(start !== undefined && { startedAt: iso(start) }),
      completedAt: iso(end),
      summary,
    });
  };

  const onEvent = (ev: ExecEvent) => {
    const name = ev.node.name;
    switch (ev.type) {
      case "settled":
        return;
      case "dispatch":
        started.set(name, ports.clock.now());
        return;
      case "start":
        queueLog(async () => {
          // A node restores the CAS that holds last-run.json, so a start never reads it first.
          const before = previous && (await previous)?.durations[name];
          ports.ci.info(`▷ ${name}${before ? ` (last run ${formatDuration(before)})` : ""}`);
        });
        queueCheck({ name, status: "in_progress", startedAt: iso(started.get(name)!) });
        return;
      default: {
        const now = ports.clock.now();
        queueLog(() => settle(ev, now));
      }
    }
  };

  const readLastRun = async (): Promise<LastRun | null> => {
    const path = `${opts.casBaseDir}/${LAST_RUN_FILE}`;
    if (!(await ports.fs.exists(path))) return null;
    try {
      return JSON.parse(await ports.fs.readText(path)) as LastRun;
    } catch {
      return null;
    }
  };
  // Read once, before this run writes it, so "vs last" compares against the previous run.
  let previous: Promise<LastRun | null> | undefined;
  const lastRun = () => (previous ??= readLastRun());
  /** Written as nodes settle, so a CAS saved from inside the graph carries this run's durations. */
  const writeLastRun = async () => {
    const before = (await lastRun())?.durations;
    await ports.fs.ensureDir(opts.casBaseDir);
    await ports.fs.writeText(
      `${opts.casBaseDir}/${LAST_RUN_FILE}`,
      JSON.stringify({ durations: { ...before, ...durations } }, null, 2),
    );
  };

  const nodeOf = new Map(opts.nodes.map((n) => [n.name, n]));
  const logOf = async (r: ExecResult): Promise<string[]> => {
    switch (r.status) {
      case "done":
      case "cached":
        return logLines(r.actionKey);
      case "fail":
        return failureBody(await logLines(r.actionKey), failureText(nodeOf.get(r.name), r.error));
      case "dep-failed":
        return [r.error.message];
      case "cancelled":
        return logLines(r.actionKey);
    }
  };

  const finish = async (results: ExecResult[]): Promise<{ failed: number; markdown: string }> => {
    await logs;
    await checks;
    const lastDurations = (await lastRun())?.durations ?? {};
    await writeLastRun();
    const byName = new Map(results.map((r) => [r.name, r]));
    const nodes = opts.nodes.flatMap((n): NodeReport[] => {
      const r = byName.get(n.name);
      if (!r) return [];
      const t = timing.get(n.name);
      const before = lastDurations[n.name];
      return [
        {
          ...n,
          status: r.status,
          ...(t && { start: t.start, duration: t.end - t.start }),
          ...(before !== undefined && { previous: before }),
          ...(r.status === "fail" && { error: failureText(n, r.error) }),
          ...(r.status === "dep-failed" && { error: r.error.message }),
          ...((r.status === "done" || r.status === "cached") && { outputs: r.outputs }),
        },
      ];
    });
    const log = async (name: string) => {
      const r = byName.get(name);
      return r ? logOf(r) : [];
    };
    const title = opts.title ?? "dagactions";
    const markdown = await renderSummary(
      title,
      { nodes, log },
      opts.summary ?? DEFAULT_SUMMARY_RENDERERS,
      (message) => ports.ci.annotate("warning", "dagactions summary", message),
    );
    await ports.ci.summary(markdown);
    for (const line of ["", ...footer(title, nodes, opts.rerun)]) ports.ci.info(line);
    const failed = results.filter((r) => r.status !== "done" && r.status !== "cached").length;
    return { failed, markdown };
  };

  return { onEvent, finish };
}
