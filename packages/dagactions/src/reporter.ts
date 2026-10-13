import {
  mermaidBody,
  outputDirFor,
  tally,
  type ExecEvent,
  type ExecResult,
  type Node,
} from "@mrmeku/dagraph";
import {
  CHECK_TEXT_LINES,
  FAILURE_LOG_LINES,
  LAST_RUN_FILE,
  MAX_GRAPH_NODES,
  SUMMARY_BUDGET_BYTES,
} from "./config.ts";
import type { CheckConclusion, Ports } from "./ports.ts";

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

const ICON: Record<Status, string> = {
  done: "✓",
  cached: "⚡",
  fail: "✗",
  "dep-failed": "⊘",
  cancelled: "◌",
};
const CONCLUSION: Record<Status, CheckConclusion> = {
  done: "success",
  cached: "success",
  fail: "failure",
  "dep-failed": "skipped",
  cancelled: "cancelled",
};
const MERMAID_CLASS: Record<Status, string> = {
  done: "done",
  cached: "cached",
  fail: "fail",
  "dep-failed": "skipped",
  cancelled: "skipped",
};
const MERMAID_CLASSDEFS = [
  "classDef done fill:#dcfce7,stroke:#16a34a,color:#14532d",
  "classDef cached fill:#f1f5f9,stroke:#94a3b8,color:#475569",
  "classDef fail fill:#fee2e2,stroke:#dc2626,color:#7f1d1d",
  "classDef skipped fill:#f8fafc,stroke:#cbd5e1,stroke-dasharray:4 4,color:#94a3b8",
];

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatDelta(now: number, before: number): string {
  const pct = Math.round(((now - before) / before) * 100);
  return pct === 0 ? "±0%" : pct > 0 ? `+${pct}%` : `${pct}%`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function lines(text: string): string[] {
  const t = text.trimEnd();
  return t ? t.split("\n") : [];
}

/**
 * The DAG as a mermaid flowchart colored by status: the engine's `mermaidBody` with status
 * icons and classes. Past MAX_GRAPH_NODES it draws one node per kind with counts instead,
 * because GitHub refuses very large diagrams.
 */
export function dagMermaid(
  nodes: Node[],
  statusOf: (name: string) => Status | undefined,
): string[] {
  if (nodes.length > MAX_GRAPH_NODES) {
    const kinds = [...new Set(nodes.map((n) => n.kind))];
    const id = (kind: string) => `k${kinds.indexOf(kind)}`;
    const out = ["```mermaid", "flowchart LR"];
    for (const kind of kinds) {
      const members = nodes.filter((n) => n.kind === kind);
      const counts = (["done", "cached", "fail", "dep-failed", "cancelled"] as Status[])
        .map((s) => [s, members.filter((n) => statusOf(n.name) === s).length] as const)
        .filter(([, c]) => c > 0)
        .map(([s, c]) => `${ICON[s]}${c}`)
        .join(" ");
      out.push(`  ${id(kind)}["${kind} ×${members.length}: ${counts}"]`);
    }
    const byName = new Map(nodes.map((n) => [n.name, n]));
    const edges = new Set<string>();
    for (const n of nodes) {
      for (const d of n.deps) {
        const from = id(byName.get(d)!.kind);
        const to = id(n.kind);
        if (from !== to) edges.add(`  ${from} --> ${to}`);
      }
    }
    out.push(...edges, "```");
    return out;
  }
  const { lines: body } = mermaidBody(nodes, {
    label: (n, scope) => {
      const status = statusOf(n.name);
      return `${status ? ICON[status] : "·"} ${scope ? n.name.slice(scope.length + 1) : n.name}`;
    },
    classOf: (n) => {
      const status = statusOf(n.name);
      return status && MERMAID_CLASS[status];
    },
  });
  return ["```mermaid", "flowchart LR", ...body, ...MERMAID_CLASSDEFS.map((c) => `  ${c}`), "```"];
}

/** Longest chain through the DAG by node duration: the one worth speeding up. */
export function criticalPath(
  nodes: Node[],
  durationOf: (name: string) => number | undefined,
): { names: string[]; total: number } | null {
  const total = new Map<string, number>();
  const via = new Map<string, string | undefined>();
  for (const n of nodes) {
    const own = durationOf(n.name);
    if (own === undefined) continue;
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
  let end: string | undefined;
  for (const [name, t] of total) if (end === undefined || t > total.get(end)!) end = name;
  if (end === undefined || total.get(end) === 0) return null;
  const names: string[] = [];
  for (let cur: string | undefined = end; cur !== undefined; cur = via.get(cur)) names.unshift(cur);
  return { names, total: total.get(end)! };
}

/**
 * Turns dagraph's event stream into CI output: a live check per node (in_progress at dispatch,
 * completed at settle), one collapsible group per node emitted when it settles so concurrent
 * nodes never interleave, an annotation per failure, and a markdown summary: status line with
 * wall time, parallelism and cache savings; the DAG colored by status; failures with their log
 * tails; a node table with durations and the change against the previous run; the critical
 * path; and a gantt of what ran. Logs are read back from the CAS, which is why cached and failed
 * nodes still show their output.
 */
export function createReporter(
  ports: Ports,
  opts: { casBaseDir: string; nodes: Node[]; title?: string },
) {
  const started = new Map<string, number>();
  const timing = new Map<string, Timing>();
  const durations: Record<string, number> = {};
  let chain = Promise.resolve();
  const queue = (work: () => Promise<void>) => {
    chain = chain.then(work);
  };

  const logLines = async (actionKey: string): Promise<string[]> => {
    const read = async (file: string) => {
      const path = `${outputDirFor(opts.casBaseDir, actionKey)}/${file}`;
      return (await ports.fs.exists(path)) ? lines(await ports.fs.readText(path)) : [];
    };
    const out = await read("stdout.log");
    const err = await read("stderr.log");
    return err.length > 0 ? [...out, "── stderr ──", ...err] : out;
  };

  const failureBody = async (actionKey: string, message: string): Promise<string[]> => [
    ...(actionKey ? await logLines(actionKey) : []),
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
    switch (ev.type) {
      case "done":
        body = await logLines(ev.actionKey);
        ports.ci.group(`✓ ${name} (${dur})`, body);
        summary = `done in ${dur}`;
        break;
      case "cached":
        body = await logLines(ev.actionKey);
        ports.ci.group(`⚡ ${name} (cached)`, body);
        summary = "cached";
        break;
      case "fail": {
        const message = errorText(ev.error);
        body = await failureBody(ev.actionKey, message);
        ports.ci.group(`✗ ${name} (${dur})`, body);
        ports.ci.annotate("error", name, message);
        summary = message;
        break;
      }
      case "dep-failed":
        summary = errorText(ev.error);
        body = [];
        ports.ci.group(`⊘ ${name} (dependency failed)`, [summary]);
        break;
      case "cancelled":
        summary = "cancelled";
        body = [];
        ports.ci.group(`◌ ${name} (cancelled)`, []);
        break;
    }
    // The node's log becomes the check's own page on GitHub.
    const details =
      body.length > 0 ? ["```text", ...body.slice(-CHECK_TEXT_LINES), "```"].join("\n") : undefined;
    await ports.ci.check({
      name,
      status: "completed",
      conclusion: CONCLUSION[ev.type],
      ...(start !== undefined && { startedAt: iso(start) }),
      completedAt: iso(end),
      summary,
      ...(details && { details }),
    });
  };

  const onEvent = (ev: ExecEvent) => {
    if (ev.type === "start" || ev.type === "settled") return;
    const now = ports.clock.now();
    if (ev.type === "dispatch") {
      started.set(ev.node.name, now);
      queue(() =>
        ports.ci.check({ name: ev.node.name, status: "in_progress", startedAt: iso(now) }),
      );
      return;
    }
    queue(() => settle(ev, now));
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

  const finish = async (results: ExecResult[]): Promise<{ failed: number; markdown: string }> => {
    await chain;
    const sorted = [...results].sort((a, b) => a.name.localeCompare(b.name));
    const statusOf = (name: string) => results.find((r) => r.name === name)?.status;
    const durationOf = (name: string) => {
      const t = timing.get(name);
      return t ? t.end - t.start : undefined;
    };
    const counts = tally(results);
    const prev = await lastRun();

    const all = [...timing.values()];
    const wall = all.length
      ? Math.max(...all.map((t) => t.end)) - Math.min(...all.map((t) => t.start))
      : 0;
    const executed = sorted.filter((r) => r.status === "done" || r.status === "fail");
    const busy = executed.reduce((s, r) => s + (durationOf(r.name) ?? 0), 0);
    const cachedNodes = sorted.filter((r) => r.status === "cached");
    const saved = cachedNodes.reduce((s, r) => s + (prev?.durations[r.name] ?? 0), 0);
    const hitDenominator = counts.cached + counts.done;

    const statusLine = [
      `built **${counts.done}** · cached **${counts.cached}** · failed **${counts.fail}** · skipped **${counts.depFailed}**${counts.cancelled > 0 ? ` · cancelled **${counts.cancelled}**` : ""}`,
      `wall ${formatDuration(wall)}`,
      ...(wall > 0 ? [`parallelism ${(busy / wall).toFixed(1)}×`] : []),
      ...(hitDenominator > 0
        ? [
            `cache ${counts.cached}/${hitDenominator} hits${saved > 0 ? `, ${formatDuration(saved)} saved` : ""}`,
          ]
        : []),
    ].join(" · ");

    const cp = criticalPath(opts.nodes, durationOf);
    const md = [`## ${opts.title ?? "dagactions"}`, "", statusLine, ""];
    if (cp) md.push(`critical path: ${cp.names.join(" → ")} (${formatDuration(cp.total)})`, "");
    md.push(...dagMermaid(opts.nodes, statusOf));

    const failures = sorted.filter((r) => r.status !== "done" && r.status !== "cached");
    const failureBlocks: string[] = [];
    for (const r of failures) {
      if (r.status === "dep-failed") {
        failureBlocks.push(`- ⊘ ${r.name}: skipped, dependency failed`);
        continue;
      }
      if (r.status === "cancelled") {
        failureBlocks.push(`- ◌ ${r.name}: cancelled`);
        continue;
      }
      const dur = durationOf(r.name);
      const body = (await failureBody(r.actionKey, r.error.message)).slice(-FAILURE_LOG_LINES);
      failureBlocks.push(
        `<details><summary>✗ ${r.name}${dur !== undefined ? ` (${formatDuration(dur)})` : ""}</summary>`,
        "",
        "```text",
        ...body,
        "```",
        "",
        "</details>",
        "",
      );
    }
    if (failures.length > 0) md.push("", "### failures", "", ...failureBlocks);

    md.push(
      "",
      "| node | status | duration | vs last |",
      "| --- | --- | --- | --- |",
      ...sorted.map((r) => {
        const d = durationOf(r.name);
        const before = prev?.durations[r.name];
        const delta =
          r.status === "done" && d !== undefined && before ? formatDelta(d, before) : "";
        return `| ${r.name} | ${r.status} | ${d !== undefined ? formatDuration(d) : ""} | ${delta} |`;
      }),
    );

    if (executed.length > 0) {
      md.push(
        "",
        "```mermaid",
        "gantt",
        "  title node timeline",
        "  dateFormat x",
        "  axisFormat %M:%S",
        "  section nodes",
        ...executed
          .filter((r) => timing.has(r.name))
          .map((r) => {
            const t = timing.get(r.name)!;
            return `  ${r.name.replace(/:/g, "/")} :${r.status === "fail" ? "crit" : "active"}, ${t.start}, ${t.end}`;
          }),
        "```",
      );
    }

    let markdown = md.join("\n") + "\n";
    if (markdown.length > SUMMARY_BUDGET_BYTES) {
      markdown = markdown.replace(
        /```text\n[\s\S]*?```/g,
        "_(log omitted: summary over the 1 MiB budget)_",
      );
    }

    await writeLastRun();

    await ports.ci.summary(markdown);
    return { failed: failures.length, markdown };
  };

  return { onEvent, finish };
}
