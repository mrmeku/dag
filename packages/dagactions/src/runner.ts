import {
  execute,
  FsCache,
  Graph,
  orchestrate,
  processNode,
  throttledScheduler,
  type ExecResult,
  type ProcessNodeResult,
  type ThrottledSchedulerOptions,
} from "@mrmeku/dagraph";
import { DEFAULT_JOURNAL_PATH } from "./config.ts";
import { createJournal, readJournal, type Journal } from "./journal.ts";
import type { CiContext, Ports } from "./ports.ts";
import { createReporter } from "./reporter.ts";
import { selectNodes } from "./select.ts";
import { postNodes } from "./steps.ts";
import type { SummaryRenderer } from "./summary.ts";

/** A workflow adds nodes to the graph. The ref/event come in through `ctx` for conditionals. */
export type Workflow<R = unknown> = (graph: Graph, ports: Ports, ctx: CiContext) => Promise<R>;

export interface RunOptions {
  workflow: Workflow;
  /** The workflow file as given: named in the summary's heading and in the log's reproduce line. */
  workflowFile?: string;
  ports: Ports;
  casBaseDir: string;
  /** Where the run writes its journal; `runPost` reads it. */
  journalPath?: string;
  force?: boolean;
  only?: string[];
  limits?: ThrottledSchedulerOptions;
  /** The step summary's renderers, top to bottom; the post pass draws its owed steps with the same. */
  summary?: readonly SummaryRenderer[];
  /** Cancels the run: waiting nodes settle as cancelled, running commands are interrupted. */
  signal?: AbortSignal;
}

export interface RunOutcome {
  results: ExecResult[];
  failed: number;
  markdown: string;
  cancelled: boolean;
}

const titleOf = (workflowFile: string | undefined) =>
  workflowFile ? `dagactions · ${workflowFile}` : "dagactions";

async function buildGraph(opts: { workflow: Workflow; ports: Ports; only?: string[] }) {
  const ctx = await opts.ports.ci.context();
  const full = new Graph();
  await opts.workflow(full, opts.ports, ctx);
  const graph = opts.only?.length ? selectNodes(full, opts.only) : full;
  const posts = postNodes(full).filter((n) => graph.getNodes().has(n));
  return { ctx, graph, posts, total: full.getNodes().size };
}

export async function runWorkflow(opts: RunOptions): Promise<RunOutcome> {
  const { ports } = opts;
  const { ctx, graph, total } = await buildGraph(opts);
  const names = [...graph.getNodes().keys()];
  const count = `${total} node${total === 1 ? "" : "s"}`;
  const scope = opts.only?.length
    ? `${names.length} of ${count} (--only ${opts.only.join(",")})`
    : count;
  ports.ci.group(
    `dagactions · ${ctx.provider} · ref=${ctx.ref} · ${scope}${opts.force ? " · force" : ""}`,
    names,
  );
  await ports.fs.ensureDir(opts.casBaseDir);
  const reporter = createReporter(ports, {
    casBaseDir: opts.casBaseDir,
    nodes: graph.describe(),
    title: titleOf(opts.workflowFile),
    ...(opts.workflowFile && { rerun: `npx dagactions run ${opts.workflowFile}` }),
    ...(opts.summary && { summary: opts.summary }),
  });
  const journal = createJournal(ports.fs, opts.journalPath ?? DEFAULT_JOURNAL_PATH);
  await journal.begin();
  const results = await execute(
    graph,
    { cache: new FsCache(opts.casBaseDir, ports.fs), fs: ports.fs, casBaseDir: opts.casBaseDir },
    {
      force: opts.force ?? false,
      scheduler: throttledScheduler(opts.limits),
      onEvent: (ev) => {
        reporter.onEvent(ev);
        journal.onEvent(ev);
      },
      ...(opts.signal && { signal: opts.signal }),
    },
  );
  await journal.flush();
  const { failed, markdown } = await reporter.finish(results);
  return { results, failed, markdown, cancelled: opts.signal?.aborted ?? false };
}

/** A journaled node's result, replayed so the engine feeds its outputs to the post steps. */
function replay(name: string, entry: Journal[string] | undefined): ProcessNodeResult {
  switch (entry?.status) {
    case "done":
    case "cached":
      // Replayed as cached: it ran in the main run, and its outputs are what matter here.
      return { name, actionKey: "", ...entry, status: "cached" };
    case "fail":
      return { name, actionKey: "", status: "fail", error: "failed in the main run", elapsed: 0 };
    case "dep-failed":
      return { name, actionKey: "", status: "dep-failed", error: "dependency failed" };
    default:
      return { name, actionKey: "", status: "cancelled" };
  }
}

/**
 * The action's `post:`: run the post steps the main run's journal shows as not reached, with
 * the rest of the graph replayed from the journal so the engine's dependency rules apply as
 * they would have. Nothing runs after an ordinary run, since every post step is journaled.
 */
export async function runPost(opts: Omit<RunOptions, "force" | "signal">): Promise<RunOutcome> {
  const { ports } = opts;
  const { graph, posts } = await buildGraph(opts);
  const journalPath = opts.journalPath ?? DEFAULT_JOURNAL_PATH;
  const before = await readJournal(ports.fs, journalPath);
  const owed = new Set(posts.filter((n) => !before[n] || before[n].status === "cancelled"));
  ports.ci.group(`dagactions · post · ${owed.size} of ${posts.length} post steps owed`, [...owed]);
  if (owed.size === 0) return { results: [], failed: 0, markdown: "", cancelled: false };
  const nodes = graph.getNodes();
  // The summary draws the owed post steps alone, so their edges to the rest of the graph go.
  const reporter = createReporter(ports, {
    casBaseDir: opts.casBaseDir,
    nodes: graph
      .describe()
      .filter((n) => owed.has(n.name))
      .map((n) => ({ ...n, deps: n.deps.filter((d) => owed.has(d)) })),
    title: `${titleOf(opts.workflowFile)} · post`,
    ...(opts.summary && { summary: opts.summary }),
  });
  const journal = createJournal(ports.fs, journalPath, before);
  const ctx = {
    cache: new FsCache(opts.casBaseDir, ports.fs),
    fs: ports.fs,
    casBaseDir: opts.casBaseDir,
    inputHashes: new Map(),
  };
  const all = await orchestrate(
    nodes.values(),
    (node, depHashes, depOutputs, started) =>
      owed.has(node.name)
        ? processNode(nodes.get(node.name)!, depHashes, depOutputs, ctx, { onStart: started })
        : Promise.resolve(replay(node.name, before[node.name])),
    throttledScheduler(opts.limits),
    (ev) => {
      if (!owed.has(ev.node.name)) return;
      reporter.onEvent(ev);
      journal.onEvent(ev);
    },
  );
  await journal.flush();
  const results = all.filter((r) => owed.has(r.name));
  const { failed, markdown } = await reporter.finish(results);
  return { results, failed, markdown, cancelled: false };
}
