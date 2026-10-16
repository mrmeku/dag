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
import type { EventEmitter } from "node:events";
import { DEFAULT_JOURNAL_PATH, RERUN_COMMAND } from "./config.ts";
import { createGithubStore } from "./github/renderer.ts";
import { createJournal, readJournal, type Journal } from "./journal.ts";
import { titleOf } from "./kernel/format.ts";
import type { Pass } from "./kernel/run-slice.ts";
import type { RunStore } from "./kernel/store.ts";
import type { CiContext, Ports } from "./ports.ts";
import { finishPass } from "./reporter.ts";
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
  /** The command that reruns the workflow; RERUN_COMMAND and the file by default. */
  rerunCommand?: string;
  /** What the passes report to: the GitHub renderer on `ports.ci` unless given. */
  store?: RunStore;
}

export interface RunOutcome {
  results: ExecResult[];
  failed: number;
  markdown: string;
  cancelled: boolean;
  /** 130 after a cancel, as for a Ctrl-C; 1 when a node did not succeed. */
  exitCode: number;
}

const runOutcomeOf = (outcome: Omit<RunOutcome, "exitCode">): RunOutcome => ({
  ...outcome,
  exitCode: outcome.cancelled ? 130 : outcome.failed > 0 ? 1 : 0,
});

async function buildGraph(opts: { workflow: Workflow; ports: Ports; only?: string[] }) {
  const ctx = await opts.ports.ci.context();
  const full = new Graph();
  await opts.workflow(full, opts.ports, ctx);
  const graph = opts.only?.length ? selectNodes(full, opts.only) : full;
  const posts = postNodes(full).filter((nodeName) => graph.getNodes().has(nodeName));
  return { ctx, graph, posts, total: full.getNodes().size };
}

export async function runWorkflow(opts: RunOptions): Promise<RunOutcome> {
  const store = opts.store ?? createGithubStore(opts.ports, opts.casBaseDir);
  opts.signal?.addEventListener("abort", store.cancel, { once: true });
  const { ports } = opts;
  const { ctx, graph, total } = await buildGraph(opts);
  const names = [...graph.getNodes().keys()];
  const count = `${total} node${total === 1 ? "" : "s"}`;
  const scope = opts.only?.length
    ? `${names.length} of ${count} (--only ${opts.only.join(",")})`
    : count;
  const rerunCommand =
    opts.rerunCommand ?? (opts.workflowFile && `${RERUN_COMMAND} ${opts.workflowFile}`);
  const pass: Pass = {
    banner: {
      title: [opts.workflowFile, ctx.ref && `ref=${ctx.ref}`, scope, opts.force && "force"]
        .filter(Boolean)
        .join(" · "),
      lines: names,
    },
    title: titleOf(opts.workflowFile),
    nodes: graph.describe(),
    ...(rerunCommand && { rerunCommand }),
  };
  store.begin(pass);
  await ports.fs.ensureDir(opts.casBaseDir);
  const journal = createJournal(ports.fs, opts.journalPath ?? DEFAULT_JOURNAL_PATH);
  await journal.begin();
  const results = await execute(
    graph,
    { cache: new FsCache(opts.casBaseDir, ports.fs), fs: ports.fs, casBaseDir: opts.casBaseDir },
    {
      force: opts.force ?? false,
      scheduler: throttledScheduler(opts.limits),
      onOutput: store.onOutput,
      onEvent: (event) => {
        store.onEvent(event);
        journal.onEvent(event);
      },
      ...(opts.signal && { signal: opts.signal }),
    },
  );
  await journal.flush();
  const { failed, markdown } = await finishPass(ports, store, pass, results, opts.summary);
  return runOutcomeOf({ results, failed, markdown, cancelled: opts.signal?.aborted ?? false });
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
 * The action's `post:`: run the post steps the main run's journal shows as not finished (never
 * reached, or cancelled while they ran), with the rest of the graph replayed from the journal so
 * the engine's dependency rules apply as they would have. Nothing runs after an ordinary run,
 * since every post step is journaled.
 */
export async function runPost(opts: Omit<RunOptions, "force" | "signal">): Promise<RunOutcome> {
  const store = opts.store ?? createGithubStore(opts.ports, opts.casBaseDir);
  const { ports } = opts;
  const { graph, posts } = await buildGraph(opts);
  const journalPath = opts.journalPath ?? DEFAULT_JOURNAL_PATH;
  const before = await readJournal(ports.fs, journalPath);
  const owed = new Set(
    posts.filter((nodeName) => !before[nodeName] || before[nodeName].status === "cancelled"),
  );
  const pass: Pass = {
    // Owing nothing, the pass prints nothing: every job has a post step, most owe none.
    ...(owed.size > 0 && {
      banner: { title: `post · ${owed.size} of ${posts.length} post steps owed`, lines: [...owed] },
    }),
    title: `${titleOf(opts.workflowFile)} · post`,
    // The summary draws the owed post steps alone, so their edges to the rest of the graph go.
    nodes: graph
      .describe()
      .filter((node) => owed.has(node.name))
      .map((node) => ({ ...node, deps: node.deps.filter((dep) => owed.has(dep)) })),
  };
  store.begin(pass);
  if (owed.size === 0)
    return runOutcomeOf({ results: [], failed: 0, markdown: "", cancelled: false });
  const nodes = graph.getNodes();
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
        ? processNode(nodes.get(node.name)!, depHashes, depOutputs, ctx, {
            onStart: started,
            onOutput: (chunk) => store.onOutput(node, chunk),
          })
        : Promise.resolve(replay(node.name, before[node.name])),
    throttledScheduler(opts.limits),
    (event) => {
      if (!owed.has(event.node.name)) return;
      store.onEvent(event);
      journal.onEvent(event);
    },
  );
  await journal.flush();
  const results = all.filter((result) => owed.has(result.name));
  const { failed, markdown } = await finishPass(ports, store, pass, results, opts.summary);
  return runOutcomeOf({ results, failed, markdown, cancelled: false });
}

/**
 * The job as one process runs it, which the action splits between its `main` and `post`: the
 * run; after a cancel, the post steps it owes, drawn as the run is; then the store's close, with
 * what either pass threw. An exit of `processEvents` before the close is done is a forced one (a second
 * Ctrl-C), and interrupts the store. Resolves to the run's exit code.
 */
export async function runJob(
  opts: RunOptions,
  processEvents: Pick<EventEmitter, "once" | "off">,
): Promise<number> {
  const interrupt = () => opts.store?.interrupt();
  processEvents.once("exit", interrupt);
  try {
    let error: unknown;
    try {
      const outcome = await runWorkflow(opts);
      if (outcome.cancelled) await runPost(opts);
      return outcome.exitCode;
    } catch (e) {
      error = e;
      throw e;
    } finally {
      await opts.store?.close(error);
    }
  } finally {
    processEvents.off("exit", interrupt);
  }
}
