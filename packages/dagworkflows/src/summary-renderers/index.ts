import type { NodeResult } from "@mrmeku/dagraph";
import { mermaidBody, mermaidQuote } from "@mrmeku/dagraph/mermaid";
import {
  CRITICAL_PATH_FLOOR_MS,
  FAILURE_LOG_TAIL_LINES,
  MAX_GRAPH_NODES,
} from "../config/index.ts";
import { logBlock, type SummaryRenderer } from "../github-step-summary/index.ts";
import {
  STATUS_ICON,
  countsLine,
  formatDuration,
  namesOf,
  reportHeadline,
  selectors,
  wallTimeOf,
  type NodeReport,
} from "../kernel/index.ts";
import type { RunReport } from "../run-store/index.ts";

/**
 * The step summary's renderers, top to bottom, for a workflow that sets no `summary`. The node
 * table is left out; `[...DEFAULT_SUMMARY_RENDERERS, renderTable]` puts it back at the bottom.
 */
export const DEFAULT_SUMMARY_RENDERERS: readonly SummaryRenderer<RunReport>[] = [
  renderStatus,
  renderTimeline,
  renderCriticalPath,
  renderDag,
  renderFailures,
];

function mermaidClassOf(result: NodeResult): string {
  switch (result.status) {
    case "succeeded":
      return result.details.actionRan ? "done" : "cached";
    case "failed":
      return "fail";
    case "dep-failed":
    case "cancelled":
      return "skipped";
  }
}
const MERMAID_CLASSDEFS = [
  "classDef done fill:#dcfce7,stroke:#16a34a,color:#14532d",
  "classDef cached fill:#f1f5f9,stroke:#94a3b8,color:#475569",
  "classDef fail fill:#fee2e2,stroke:#dc2626,color:#7f1d1d",
  "classDef skipped fill:#f8fafc,stroke:#cbd5e1,stroke-dasharray:4 4,color:#94a3b8",
];

function formatDelta(now: number, before: number): string {
  const pct = Math.round(((now - before) / before) * 100);
  return pct === 0 ? "±0%" : pct > 0 ? `+${pct}%` : `${pct}%`;
}

const byName = (nodes: NodeReport[]) =>
  [...nodes].sort((a, b) => a.node.name.localeCompare(b.node.name));
const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0);
/**
 * The DAG as a mermaid flowchart colored by status: `@mrmeku/dagraph/mermaid`'s `mermaidBody`,
 * each node under its full name, with status icons and classes. Deps outside `reports` are left
 * out, so a filtered set draws. Past
 * MAX_GRAPH_NODES it draws one node per kind with counts instead, because GitHub refuses very
 * large diagrams.
 */
function dagMermaid(reports: NodeReport[]): string[] {
  const names = new Set(reports.map(({ node }) => node.name));
  const nodes = reports.map(({ node, result }) => ({
    ...node,
    deps: node.deps.filter((d) => names.has(d)),
    result,
  }));
  if (nodes.length > MAX_GRAPH_NODES) {
    const kinds = [...new Set(nodes.map((n) => n.kind))];
    const id = (kind: string) => `k${kinds.indexOf(kind)}`;
    const out = ["```mermaid", "flowchart LR"];
    for (const kind of kinds) {
      const members = nodes.filter((n) => n.kind === kind);
      const counts = (
        ["succeeded", "failed", "dep-failed", "cancelled"] satisfies NodeResult["status"][]
      )
        .map((s) => [s, members.filter((n) => n.result.status === s).length] as const)
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
    label: (n) => `${STATUS_ICON[n.result.status]} ${n.name}`,
    classOf: (n) => mermaidClassOf(n.result),
  });
  return ["```mermaid", "flowchart LR", ...body, ...MERMAID_CLASSDEFS.map((c) => `  ${c}`), "```"];
}

/** Longest chain through the DAG by node duration: the one worth speeding up. `nodes` in graph order. */
function longestChain(nodes: NodeReport[]): { names: string[]; total: number } | null {
  const counted = new Set(
    nodes.filter((n) => (n.duration ?? 0) >= CRITICAL_PATH_FLOOR_MS).map((n) => n.node.name),
  );
  const total = new Map<string, number>();
  const via = new Map<string, string | undefined>();
  for (const n of nodes) {
    if (n.duration === undefined) continue;
    const own = counted.has(n.node.name) ? n.duration : 0;
    let best = 0;
    let bestDep: string | undefined;
    for (const d of n.node.deps) {
      const t = total.get(d) ?? 0;
      if (t > best) {
        best = t;
        bestDep = d;
      }
    }
    total.set(n.node.name, own + best);
    via.set(n.node.name, bestDep);
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
  const busy = sum(
    nodes.filter((n) => selectors.ranToItsEnd(n.result)).map((n) => n.duration ?? 0),
  );
  const cacheHits = nodes.filter(
    ({ result }) => result.status === "succeeded" && !result.details.actionRan,
  );
  const saved = sum(cacheHits.map((n) => n.previous ?? 0));
  const hits = cacheHits.length;
  const lookups = namesOf(nodes, "succeeded").length;
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

/** A mermaid gantt of the nodes that ran to their end: what happened when, and what overlapped. */
export function renderTimeline({ nodes }: RunReport): string[] {
  const bars = byName(nodes)
    .filter((n) => selectors.ranToItsEnd(n.result))
    .flatMap((n) =>
      n.start === undefined
        ? []
        : `  ${n.node.name.replace(/:/g, "/")} :${n.result.status === "failed" ? "crit" : "done"}, ${n.start}, ${n.start + (n.duration ?? 0)}`,
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
  return nodes.length > 0 ? dagMermaid(nodes) : [];
}

/**
 * Each failed node's log tail in a collapsed block, and one line per skipped or cancelled node,
 * in graph order: a failure's cause comes before what it broke.
 */
export async function renderFailures({ nodes, log }: RunReport): Promise<string[]> {
  const lines: string[] = [];
  for (const { node, result, duration } of nodes) {
    switch (result.status) {
      case "succeeded":
        break;
      case "dep-failed":
        lines.push(`- ${STATUS_ICON["dep-failed"]} ${node.name}: skipped, dependency failed`);
        break;
      case "cancelled":
        lines.push(`- ${STATUS_ICON.cancelled} ${node.name}: cancelled`);
        break;
      case "failed": {
        const detail = !selectors.actionRan(result)
          ? " (not started)"
          : duration !== undefined
            ? ` (${formatDuration(duration)})`
            : "";
        lines.push(
          `<details><summary>${STATUS_ICON.failed} ${node.name}${detail}</summary>`,
          "",
          ...logBlock((await log(node.name)).slice(-FAILURE_LOG_TAIL_LINES)),
          "",
          "</details>",
          "",
        );
      }
    }
  }
  if (lines.at(-1) === "") lines.pop();
  return lines.length > 0 ? ["### failures", "", ...lines] : [];
}

/** Node, status, duration and the change against the previous run. */
export function renderTable({ nodes }: RunReport): string[] {
  return [
    "| node | status | duration | vs last |",
    "| --- | --- | --- | --- |",
    ...byName(nodes).map(({ node, result, duration, previous }) => {
      const row = (status: string, delta = "") =>
        `| ${node.name} | ${status} | ${duration !== undefined ? formatDuration(duration) : ""} | ${delta} |`;
      switch (result.status) {
        case "succeeded":
          if (!result.details.actionRan) return row("cached");
          return row(
            "done",
            duration !== undefined && previous ? formatDelta(duration, previous) : "",
          );
        case "failed":
        case "dep-failed":
        case "cancelled":
          return row(result.status);
      }
    }),
  ];
}
