import type { Node, Result } from "@mrmeku/dagraph";
import { mermaidBody, mermaidQuote } from "@mrmeku/dagraph/mermaid";
import {
  CRITICAL_PATH_FLOOR_MS,
  FAILURES_REPORT_LOG_LINES,
  MAX_GRAPH_NODES,
  STATUS_ICON,
  SUMMARY_BUDGET_BYTES,
} from "./config.ts";
import { countsLine, errorMessage, formatDuration, reportHeadline } from "./kernel/format.ts";
import { namesOf, wallTimeOf, type NodeReport } from "./kernel/report.ts";
import * as selectors from "./kernel/selectors.ts";

type Status = Result["status"];

/** The run's data, as every renderer gets it. In the post pass it holds the owed post steps alone. */
export interface RunReport {
  /** In graph order, which is topological. */
  nodes: NodeReport[];
  /** A node's log as its group printed it, read back from the CAS: stdout, stderr, then a failure's error. */
  log: (name: string) => Promise<string[]>;
}

/** Renders one block of the step summary from the run's data, as markdown lines. [] renders nothing. */
export type SummaryRenderer = (report: RunReport) => string[] | Promise<string[]>;

/**
 * The step summary's renderers, top to bottom, for a workflow that sets no `summary`. The node
 * table is left out; `[...DEFAULT_SUMMARY_RENDERERS, renderTable]` puts it back at the bottom.
 */
export const DEFAULT_SUMMARY_RENDERERS: readonly SummaryRenderer[] = [
  renderStatus,
  renderTimeline,
  renderCriticalPath,
  renderDag,
  renderFailures,
];

const MERMAID_CLASS: Record<Status, string> = {
  done: "done",
  cached: "cached",
  failed: "fail",
  "dep-failed": "skipped",
  cancelled: "skipped",
};
const MERMAID_CLASSDEFS = [
  "classDef done fill:#dcfce7,stroke:#16a34a,color:#14532d",
  "classDef cached fill:#f1f5f9,stroke:#94a3b8,color:#475569",
  "classDef fail fill:#fee2e2,stroke:#dc2626,color:#7f1d1d",
  "classDef skipped fill:#f8fafc,stroke:#cbd5e1,stroke-dasharray:4 4,color:#94a3b8",
];
const LOG_BLOCK = /```text\n[\s\S]*?```/g;

function formatDelta(now: number, before: number): string {
  const pct = Math.round(((now - before) / before) * 100);
  return pct === 0 ? "±0%" : pct > 0 ? `+${pct}%` : `${pct}%`;
}

const byName = (nodes: NodeReport[]) => [...nodes].sort((a, b) => a.name.localeCompare(b.name));
const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0);
/**
 * The DAG as a mermaid flowchart colored by status: `@mrmeku/dagraph/mermaid`'s `mermaidBody`,
 * each node under its full name, with status icons and classes. Deps outside `nodes` are left
 * out, so a filtered set draws. Past
 * MAX_GRAPH_NODES it draws one node per kind with counts instead, because GitHub refuses very
 * large diagrams.
 */
export function dagMermaid(all: Node[], statusOf: (name: string) => Status | undefined): string[] {
  const names = new Set(all.map((n) => n.name));
  const nodes = all.map((n) => ({ ...n, deps: n.deps.filter((d) => names.has(d)) }));
  if (nodes.length > MAX_GRAPH_NODES) {
    const kinds = [...new Set(nodes.map((n) => n.kind))];
    const id = (kind: string) => `k${kinds.indexOf(kind)}`;
    const out = ["```mermaid", "flowchart LR"];
    for (const kind of kinds) {
      const members = nodes.filter((n) => n.kind === kind);
      const counts = (["done", "cached", "failed", "dep-failed", "cancelled"] satisfies Status[])
        .map((s) => [s, members.filter((n) => statusOf(n.name) === s).length] as const)
        .filter(([, c]) => c > 0)
        .map(([s, c]) => `${STATUS_ICON[s]}${c}`)
        .join(" ");
      out.push(`  ${id(kind)}[${mermaidQuote(`${kind} ×${members.length}: ${counts}`)}]`);
    }
    const byNodeName = new Map(nodes.map((n) => [n.name, n]));
    const edges = new Set<string>();
    for (const n of nodes) {
      for (const dep of n.deps.flatMap((d) => byNodeName.get(d) ?? [])) {
        const from = id(dep.kind);
        const to = id(n.kind);
        if (from !== to) edges.add(`  ${from} --> ${to}`);
      }
    }
    out.push(...edges, "```");
    return out;
  }
  const { lines: body } = mermaidBody(nodes, {
    label: (n) => {
      const status = statusOf(n.name);
      return `${status ? STATUS_ICON[status] : "·"} ${n.name}`;
    },
    classOf: (n) => {
      const status = statusOf(n.name);
      return status && MERMAID_CLASS[status];
    },
  });
  return ["```mermaid", "flowchart LR", ...body, ...MERMAID_CLASSDEFS.map((c) => `  ${c}`), "```"];
}

/** Longest chain through the DAG by node duration: the one worth speeding up. `nodes` in graph order. */
function longestChain(nodes: NodeReport[]): { names: string[]; total: number } | null {
  const counted = new Set(
    nodes.filter((n) => (n.duration ?? 0) >= CRITICAL_PATH_FLOOR_MS).map((n) => n.name),
  );
  const total = new Map<string, number>();
  const via = new Map<string, string | undefined>();
  for (const n of nodes) {
    if (n.duration === undefined) continue;
    const own = counted.has(n.name) ? n.duration : 0;
    let best = 0;
    let bestDep: string | undefined;
    for (const d of n.deps) {
      const t = total.get(d) ?? 0;
      if (t > best) {
        best = t;
        bestDep = d;
      }
    }
    total.set(n.name, own + best);
    via.set(n.name, bestDep);
  }
  let end: { name: string; total: number } | undefined;
  for (const [name, t] of total) if (end === undefined || t > end.total) end = { name, total: t };
  if (end === undefined || end.total === 0) return null;
  const names: string[] = [];
  for (let cur: string | undefined = end.name; cur !== undefined; cur = via.get(cur))
    names.unshift(cur);
  return { names: names.filter((name) => counted.has(name)), total: end.total };
}

/**
 * The outcome as a headline (the failures' causes, or that every node succeeded), then counts,
 * wall time, parallelism, cache hits and the time they saved.
 */
export function renderStatus({ nodes }: RunReport): string[] {
  const wall = wallTimeOf(nodes);
  const busy = sum(nodes.filter(selectors.ran).map((n) => n.duration ?? 0));
  const saved = sum(nodes.filter((n) => n.status === "cached").map((n) => n.previous ?? 0));
  const hits = namesOf(nodes, "cached").length;
  const lookups = hits + namesOf(nodes, "done").length;
  return [
    `### ${reportHeadline(nodes)}`,
    "",
    [
      countsLine(nodes, (n) => `**${n}**`),
      `wall ${formatDuration(wall)}`,
      ...(wall > 0 ? [`parallelism ${(busy / wall).toFixed(1)}×`] : []),
      ...(lookups > 0
        ? [`cache ${hits}/${lookups} hits${saved > 0 ? `, ${formatDuration(saved)} saved` : ""}`]
        : []),
    ].join(" · "),
  ];
}

/** A mermaid gantt of the nodes that ran: what happened when, and what overlapped. */
export function renderTimeline({ nodes }: RunReport): string[] {
  const bars = byName(nodes)
    .filter(selectors.ran)
    .flatMap((n) =>
      n.start === undefined
        ? []
        : `  ${n.name.replace(/:/g, "/")} :${n.status === "failed" ? "crit" : "done"}, ${n.start}, ${n.start + (n.duration ?? 0)}`,
    );
  if (bars.length === 0) return [];
  return [
    "```mermaid",
    "gantt",
    "  title node timeline",
    "  dateFormat x",
    "  axisFormat %M:%S",
    "  section nodes",
    ...bars,
    "```",
  ];
}

/** One line: the longest chain by duration, of nodes that took CRITICAL_PATH_FLOOR_MS or more. */
export function renderCriticalPath({ nodes }: RunReport): string[] {
  const cp = longestChain(nodes);
  return cp ? [`critical path: ${cp.names.join(" → ")} (${formatDuration(cp.total)})`] : [];
}

/**
 * The DAG as a mermaid flowchart colored by status. Pass it a filtered report to draw part of
 * the graph: `renderDag({ ...r, nodes: r.nodes.filter(keep) })`.
 */
export function renderDag({ nodes }: RunReport): string[] {
  const status = new Map(nodes.map((n) => [n.name, n.status]));
  return nodes.length > 0 ? dagMermaid(nodes, (name) => status.get(name)) : [];
}

/**
 * Each failed node's log tail in a collapsed block, and one line per skipped or cancelled node,
 * in graph order: a failure's cause comes before what it broke.
 */
export async function renderFailures({ nodes, log }: RunReport): Promise<string[]> {
  const lines: string[] = [];
  for (const n of nodes) {
    if (n.status === "dep-failed")
      lines.push(`- ${STATUS_ICON["dep-failed"]} ${n.name}: skipped, dependency failed`);
    if (n.status === "cancelled") lines.push(`- ${STATUS_ICON.cancelled} ${n.name}: cancelled`);
    if (n.status !== "failed") continue;
    const detail =
      n.failedWhile === "waiting"
        ? " (not started)"
        : n.duration !== undefined
          ? ` (${formatDuration(n.duration)})`
          : "";
    lines.push(
      `<details><summary>${STATUS_ICON.failed} ${n.name}${detail}</summary>`,
      "",
      "```text",
      ...(await log(n.name)).slice(-FAILURES_REPORT_LOG_LINES),
      "```",
      "",
      "</details>",
      "",
    );
  }
  if (lines.at(-1) === "") lines.pop();
  return lines.length > 0 ? ["### failures", "", ...lines] : [];
}

/** Node, status, duration and the change against the previous run. */
export function renderTable({ nodes }: RunReport): string[] {
  return [
    "| node | status | duration | vs last |",
    "| --- | --- | --- | --- |",
    ...byName(nodes).map((n) => {
      const d = n.duration;
      const delta =
        n.status === "done" && d !== undefined && n.previous ? formatDelta(d, n.previous) : "";
      return `| ${n.name} | ${n.status} | ${d !== undefined ? formatDuration(d) : ""} | ${delta} |`;
    }),
  ];
}

/**
 * The step summary: `## title`, then each renderer's block that is not empty, a blank line apart.
 * A renderer that throws leaves a note in its place and is reported through `warn`; the run's
 * outcome never depends on it. Over `budget` UTF-8 bytes, every log block is dropped, then each
 * block that no longer fits, so the renderers listed first keep their room.
 */
export async function renderSummary(
  title: string,
  report: RunReport,
  renderers: readonly SummaryRenderer[],
  warn: (message: string) => void,
  budget = SUMMARY_BUDGET_BYTES,
): Promise<string> {
  const parts: Array<[name: string, text: string]> = [];
  for (const [i, render] of renderers.entries()) {
    const name = render.name || `#${i + 1}`;
    try {
      const lines = await render(report);
      if (lines.length > 0) parts.push([name, lines.join("\n")]);
    } catch (e) {
      const message = `${name} failed: ${errorMessage(e)}`;
      warn(message);
      parts.push([name, `_(${message})_`]);
    }
  }
  if (parts.length === 0) return "";
  const all: Array<[string, string]> = [["heading", `## ${title}`], ...parts];
  const size = (text: string) => Buffer.byteLength(text) + 2;
  let texts = all.map(([, text]) => text);
  if (sum(texts.map(size)) > budget) {
    let left = budget;
    texts = all.map(([name, text]) => {
      const trimmed = text.replace(LOG_BLOCK, "_(log omitted: summary over the 1 MiB budget)_");
      if (size(trimmed) > left) return `_(${name} omitted: summary over the 1 MiB budget)_`;
      left -= size(trimmed);
      return trimmed;
    });
  }
  return texts.join("\n\n") + "\n";
}
