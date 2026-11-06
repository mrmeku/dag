import {
  closure,
  errorMessage,
  execute,
  Graph,
  isSucceeded,
  orchestrate,
  runNode,
  throttledScheduler,
  type ExecuteOptions,
  type Node,
  type NodeResult,
  type SucceededNodeDetails,
} from "@mrmeku/dagraph";
import { resolve } from "node:path";
import {
  DEFAULT_BUILD_LOG_DIR,
  DEFAULT_DURATIONS_DIR,
  DEFAULT_HISTORY_DIR,
  RERUN_COMMAND,
} from "../config/index.ts";
import {
  claimHistory,
  createRunHistory,
  owedPosts,
  readRunHistory,
  removeHistory,
  stoppedHistories,
  type OpenRunHistory,
  type RunHistoryFile,
} from "../history/index.ts";
import { scopeOf, titleOf, type Pass } from "../kernel/index.ts";
import { githubRenderer, publishSummary } from "../reporter/index.ts";
import { createRunStore, durationsFileOf, type RunStore } from "../run-store/index.ts";
import { postNodes, saveNodes, selectNodes } from "../selection/index.ts";
import type { Ports, RunDataPaths, WorkflowDef } from "../workflow/index.ts";

/**
 * A run's options: its workflow's `implementation`, `schedulerOptions` and `summary` (the post pass
 * draws with the same), `execute`'s `signal`, and these.
 */
export type RunOptions = Pick<ExecuteOptions, "signal"> &
  Pick<WorkflowDef, "implementation" | "schedulerOptions" | "summary"> &
  RunDataPaths & {
    /** Every node runs, its entry unread, and writes its new entry. */
    force?: boolean;
    /** The workflow file as given: named in the summary's heading and in the log's reproduce line. */
    workflowFile?: string;
    ports: Ports;
    /** Where each built node's log is kept, by action key: DEFAULT_BUILD_LOG_DIR unless given. */
    buildLogDir?: string;
    /** The directory where each run writes its history; the post pass reads them. */
    historyDir?: string;
    only?: string[];
    /** The command that reruns the workflow; RERUN_COMMAND and the file by default. */
    rerunCommand?: string;
    /** What the passes report to: the GitHub renderer on `ports.host` unless given. */
    store?: RunStore;
  };

type PostOptions = Omit<RunOptions, "force" | "signal">;

export interface RunOutcome {
  results: NodeResult[];
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

/** The workflow a run's history belongs to: its file resolved, so `ci.ts` and `./ci.ts` are one. */
const historyWorkflowOf = (opts: { workflowFile?: string }) =>
  opts.workflowFile ? resolve(opts.workflowFile) : "";

/** The store a run reports to unless given one: the GitHub renderer on the run's host. */
const defaultStore = (opts: PostOptions): RunStore =>
  createRunStore({
    fs: opts.ports.fs,
    buildLogDir: opts.buildLogDir ?? DEFAULT_BUILD_LOG_DIR,
    durationsFile: durationsFileOf(opts.durationsDir ?? DEFAULT_DURATIONS_DIR, opts.workflowFile),
    listeners: [githubRenderer(opts.ports.host)],
  });

/** The execution context a pass runs its nodes with. */
const executionContextOf = (opts: PostOptions) => ({
  ports: opts.ports,
  fs: opts.ports.fs,
  cacheDir: opts.cacheDir,
  clock: opts.ports.clock,
  startTimer: opts.ports.startTimer,
});

async function buildGraph(opts: PostOptions) {
  const ctx = await opts.ports.host.context();
  const full = new Graph<Ports>();
  await opts.implementation(full, opts.ports, ctx, opts);
  return { ctx, full };
}

/**
 * Run the post steps that runs of this workflow no longer going owe, each over the graph its
 * history says it ran (its `--only` of `full`), as passes on `store`, and remove each run's
 * history once it owes nothing: one whose post failed again stays for the next pass. Another
 * workflow's history is left for that workflow. A history that cannot be read is dropped with a
 * warning.
 */
async function payOwedPosts(
  opts: PostOptions,
  full: Graph<Ports>,
  store: RunStore,
): Promise<RunOutcome[]> {
  const { fs, host, lockfile } = opts.ports;
  const outcomes: RunOutcome[] = [];
  for (const path of await stoppedHistories(fs, lockfile, opts.historyDir ?? DEFAULT_HISTORY_DIR)) {
    let file: RunHistoryFile;
    let graph: Graph<Ports>;
    try {
      file = await readRunHistory(fs, path);
      if (file.workflow !== historyWorkflowOf(opts)) continue;
      graph = selectNodes(full, file.only, true);
    } catch (e) {
      // Gone: another pass claimed it since the listing.
      if (!(await fs.exists(path))) continue;
      host.annotate(
        "warning",
        "dag",
        `ignoring the run's history ${path}: ${errorMessage(e)}. The post steps it owed do not run.`,
      );
      await removeHistory(fs, path);
      continue;
    }
    const owed = owedPosts(file, postNodes(graph));
    if (owed.size === 0) {
      await removeHistory(fs, path);
      continue;
    }
    const history = await claimHistory(fs, lockfile, path, file);
    if (!history) continue;
    try {
      outcomes.push(await runPostPass(opts, graph, owed, history, store));
      if (owedPosts(history, postNodes(graph)).size === 0) await fs.remove(history.path);
    } finally {
      await history.close();
    }
  }
  return outcomes;
}

/** A pass's end: its summary published from the store's report, then the pass finished on the store. */
async function finishPass(
  opts: PostOptions,
  store: RunStore,
  pass: Pass,
  results: NodeResult[],
): Promise<{ failed: number; markdown: string }> {
  const nodes = await store.report(pass);
  const markdown = await publishSummary(
    opts.ports.host,
    pass.title,
    { nodes, log: store.log },
    opts.summary,
  );
  await store.finish(pass, nodes);
  return { failed: results.filter((result) => !isSucceeded(result)).length, markdown };
}

export async function runWorkflow(opts: RunOptions): Promise<RunOutcome> {
  const store = opts.store ?? defaultStore(opts);
  opts.signal?.addEventListener("abort", store.cancel, { once: true });
  const { ports } = opts;
  const { ctx, full } = await buildGraph(opts);
  const graph = selectNodes(full, opts.only?.length ? opts.only : undefined);
  // An owed post step may read the cache dir, which a fresh machine has not made yet.
  await ports.fs.ensureDir(opts.cacheDir);
  // Runs that stopped before their post pass owe their posts; this run pays them first. While one
  // still fails, what it set up may still be there, so no node of this run starts.
  const outcomes = await payOwedPosts(opts, full, store);
  const unpaid = outcomes.reduce((n, outcome) => n + outcome.failed, 0);
  if (unpaid > 0) {
    ports.host.annotate(
      "error",
      "dag",
      `No task ran: post steps that an earlier run owes failed again (${unpaid}), and what they ` +
        `release may still be there. Fix them and run again, or, once it is gone, remove that ` +
        `run's history in ${opts.historyDir ?? DEFAULT_HISTORY_DIR}.`,
    );
    return runOutcomeOf({
      results: outcomes.flatMap((outcome) => outcome.results),
      failed: unpaid,
      markdown: outcomes.map((outcome) => outcome.markdown).join(""),
      cancelled: false,
    });
  }
  const nodes = graph.describe();
  const names = nodes.map((node) => node.name);
  const scope = scopeOf(full.describe().length, opts.only, names.length);
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
    nodes,
    ...(rerunCommand && { rerunCommand }),
  };
  store.begin(pass);
  const history = await createRunHistory(
    ports.fs,
    ports.lockfile,
    opts.historyDir ?? DEFAULT_HISTORY_DIR,
    {
      workflow: historyWorkflowOf(opts),
      ...(opts.only?.length && { only: opts.only }),
      started: [],
      results: {},
    },
  );
  const saves = saveNodes(graph);
  let results: NodeResult[];
  try {
    await history.begin();
    results = await execute(
      graph,
      { ...executionContextOf(opts), ...(opts.force && { forcedKeys: "all" }) },
      {
        scheduler: throttledScheduler(opts.schedulerOptions),
        onEvent: (event) => {
          store.onEvent(event);
          // A save carries this run's durations: they are written before its action starts.
          if (event.type === "start" && saves.has(event.node))
            return Promise.all([history.onEvent(event), store.writeDurations()]).then(() => {});
          return history.onEvent(event);
        },
        ...(opts.signal && { signal: opts.signal }),
      },
    );
    await history.flush();
    // A run that owes nothing leaves no history behind.
    if (owedPosts(history, postNodes(graph)).size === 0) await ports.fs.remove(history.path);
  } finally {
    await history.close();
  }
  // Only the run's own pass writes them: the post passes that pay earlier runs come before the restore that may bring them.
  await store.writeDurations();
  const { failed, markdown } = await finishPass(opts, store, pass, results);
  return runOutcomeOf({ results, failed, markdown, cancelled: opts.signal?.aborted ?? false });
}

/**
 * The GitHub Action's `post`, `dag post`, and `dag run`'s after a cancel: run the post steps that
 * runs no longer going owe, with what they depend on replayed from each run's history so the
 * engine's dependency rules apply as they would have. A run whose post steps all succeeded owes
 * nothing and leaves no history, so nothing runs after it.
 */
export async function runPost(opts: PostOptions): Promise<RunOutcome> {
  const store = opts.store ?? defaultStore(opts);
  const { full } = await buildGraph(opts);
  const outcomes = await payOwedPosts(opts, full, store);
  // Owing nothing, the pass prints nothing: every job has a post step, most owe none.
  if (outcomes.length === 0)
    store.begin({ title: `${titleOf(opts.workflowFile)} · post`, nodes: [] });
  return runOutcomeOf({
    results: outcomes.flatMap((o) => o.results),
    failed: outcomes.reduce((n, o) => n + o.failed, 0),
    markdown: outcomes.map((o) => o.markdown).join(""),
    cancelled: false,
  });
}

/**
 * Run the `owed` post steps of the run whose history is `history`, and record them there: an
 * executor over the closure of the owed posts, whose `RunNode` processes an owed post and replays
 * every other node as the run's history recorded it.
 */
async function runPostPass(
  opts: PostOptions,
  graph: Graph<Ports>,
  owed: Set<string>,
  history: OpenRunHistory,
  store: RunStore,
): Promise<RunOutcome> {
  const before = { ...history.results };
  const pass: Pass = {
    banner: {
      title: `post · ${owed.size} of ${postNodes(graph).size} post steps owed`,
      lines: [...owed],
    },
    title: `${titleOf(opts.workflowFile)} · post`,
    // The summary draws the owed post steps alone, so their edges to the rest of the graph go.
    nodes: graph
      .describe()
      .filter((node) => owed.has(node.name))
      .map((node) => ({ ...node, deps: node.deps.filter((dep) => owed.has(dep)) })),
  };
  store.begin(pass);
  const replayed = closure(graph, owed);
  const runOwed = runNode(replayed, executionContextOf(opts), {
    onEvent: (event) => {
      store.onEvent(event);
      return history.onEvent(event);
    },
  });
  const all = await orchestrate(
    replayed.describe(),
    (
      node: Node<undefined>,
      depDetails: Record<string, SucceededNodeDetails>,
      waitForScheduler: () => Promise<void>,
    ) =>
      // Any other node replays as the run's history recorded it, so the engine feeds its outputs
      // to the post steps; one it never recorded replays as cancelled.
      owed.has(node.name)
        ? runOwed(node, depDetails, waitForScheduler)
        : Promise.resolve(before[node.name] ?? { name: node.name, status: "cancelled" }),
    throttledScheduler(opts.schedulerOptions),
    opts.ports.clock,
    (event) => {
      if (!owed.has(event.node)) return;
      store.onEvent(event);
      return history.onEvent(event);
    },
  );
  await history.flush();
  const results = all.filter((result) => owed.has(result.name));
  const { failed, markdown } = await finishPass(opts, store, pass, results);
  return runOutcomeOf({ results, failed, markdown, cancelled: false });
}

/**
 * The job as one process runs it, which the GitHub Action splits between its `main` and `post`:
 * the run; after a cancel, the post steps it owes, drawn as the run is; then the store's close,
 * with what either pass threw. An exit of `processEvents` before the close is done is a forced one
 * (a second Ctrl-C), and interrupts the store. Resolves to the run's exit code.
 */
export async function runJob(
  opts: RunOptions,
  processEvents: Pick<NodeJS.EventEmitter, "once" | "off">,
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
