import {
  closure,
  execute,
  Graph,
  orchestrate,
  runNode,
  startGlobalTimer,
  throttledScheduler,
  type ExecuteOptions,
  type Node,
  type NodeResult,
  type SucceededNodeDetails,
} from "@mrmeku/dagraph";
import { relative, resolve } from "node:path";
import { DEFAULT_DURATIONS_DIR, DEFAULT_HISTORY_DIR, RERUN_COMMAND } from "./config.ts";
import { createGithubStore } from "./github/renderer.ts";
import {
  createRunHistory,
  readRunHistory,
  runHistoryLive,
  type RunHistoryFile,
} from "./history.ts";
import { errorMessage, titleOf } from "./kernel/format.ts";
import type { Pass } from "./kernel/run-slice.ts";
import type { RunStore } from "./kernel/store.ts";
import type { CiContext, Ports } from "./ports.ts";
import { finishPass } from "./reporter.ts";
import { selectNodes } from "./select.ts";
import { postNodes, savesOf } from "./steps.ts";
import type { WorkflowDef } from "./workflow.ts";

/** An implementation adds nodes to the graph; the ref/event come in `ctx` for conditionals. */
export type Implementation<R = unknown> = (
  graph: Graph<Ports>,
  ports: Ports,
  ctx: CiContext,
  runDataPaths?: RunDataPaths,
) => Promise<R>;

/**
 * A run's options: its workflow's `implementation`, `schedulerOptions` and `summary` (the post pass
 * draws with the same), `execute`'s `signal`, and these.
 */
export type RunOptions = Pick<ExecuteOptions, "signal"> &
  Pick<WorkflowDef, "implementation" | "schedulerOptions" | "summary"> & {
    /** Every node runs, its entry unread, and writes its new entry. */
    force?: boolean;
    /** The workflow file as given: named in the summary's heading and in the log's reproduce line. */
    workflowFile?: string;
    ports: Ports;
    cacheDir: string;
    /** Where each built node's log is kept, by action key: DEFAULT_BUILD_LOG_DIR unless given. */
    buildLogDir?: string;
    /** Where each workflow's last run's durations are kept: DEFAULT_DURATIONS_DIR unless given. */
    durationsDir?: string;
    /** The directory where each run writes its history; the post pass reads them. */
    historyDir?: string;
    only?: string[];
    /** The command that reruns the workflow; RERUN_COMMAND and the file by default. */
    rerunCommand?: string;
    /** What the passes report to: the GitHub renderer on `ports.host` unless given. */
    store?: RunStore;
  };

type PostOptions = Omit<RunOptions, "force" | "signal">;

/** The run's cache and durations dirs, for a `workflow.cache` with no `path`. */
export type RunDataPaths = Pick<RunOptions, "cacheDir" | "durationsDir">;

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
const workflowOf = (opts: { workflowFile?: string }) =>
  opts.workflowFile ? resolve(opts.workflowFile) : "";

/**
 * The file a run keeps its workflow's durations in, named by the workflow file's path from the
 * working directory, a `..` in it encoded so the file stays in the durations dir.
 */
export function durationsFileOf(opts: Pick<RunOptions, "workflowFile" | "durationsDir">): string {
  const workflow = opts.workflowFile
    ? relative(".", opts.workflowFile).replaceAll("..", "%2E%2E")
    : titleOf(undefined);
  return `${opts.durationsDir ?? DEFAULT_DURATIONS_DIR}/${workflow}.json`;
}

async function buildGraph(opts: PostOptions) {
  const ctx = await opts.ports.host.context();
  const full = new Graph<Ports>();
  await opts.implementation(full, opts.ports, ctx, opts);
  return { ctx, full };
}

/**
 * The posts a run's history shows it owes: each whose main's start it recorded, whatever came of
 * it, and that has not succeeded. A main whose start it never recorded, `dep-failed` or cancelled
 * while queued, owes nothing. A post that failed every try is still owed.
 */
function owedPosts(
  graph: Graph<Ports>,
  { results, started }: Pick<RunHistoryFile, "results" | "started">,
): Set<string> {
  return new Set(
    [...postNodes(graph)]
      .filter(([name, main]) => started.includes(main) && results[name]?.status !== "succeeded")
      .map(([name]) => name),
  );
}

/**
 * Run the post steps that runs of this workflow no longer going owe, each over the graph its
 * history says it ran (its `--only` of `full`), as passes on `store`, and remove each run's
 * history once it owes nothing: one whose post failed again stays for the next pass. Another
 * workflow's history is left for that workflow. A history that cannot be read is dropped with a
 * warning, and a write a killed run left half done is dropped.
 */
async function settle(
  opts: PostOptions,
  full: Graph<Ports>,
  store: RunStore,
): Promise<RunOutcome[]> {
  const { fs, host, lockfile } = opts.ports;
  const dir = opts.historyDir ?? DEFAULT_HISTORY_DIR;
  const outcomes: RunOutcome[] = [];
  // A stopped run's history goes with its lock, stale after a kill.
  const drop = async (path: string) => {
    await fs.remove(path);
    await fs.remove(`${path}.lock`);
  };
  for (const name of await fs.readdir(dir)) {
    const end = name.indexOf(".json") + ".json".length;
    if (end < ".json".length || name.endsWith(".lock")) continue;
    const path = `${dir}/${name.slice(0, end)}`;
    if (await runHistoryLive(lockfile, path)) continue;
    // A write a killed run left half done.
    if (name.length > end) {
      await fs.remove(`${dir}/${name}`);
      continue;
    }
    let file: RunHistoryFile;
    let graph: Graph<Ports>;
    try {
      file = await readRunHistory(fs, path);
      if (file.workflow !== workflowOf(opts)) continue;
      graph = selectNodes(full, file.only, true);
    } catch (e) {
      // Gone: another pass claimed it since the listing.
      if (!(await fs.exists(path))) continue;
      host.annotate(
        "warning",
        "dag",
        `ignoring the run's history ${path}: ${errorMessage(e)}. The post steps it owed do not run.`,
      );
      await drop(path);
      continue;
    }
    const owed = owedPosts(graph, file);
    if (owed.size === 0) {
      await drop(path);
      continue;
    }
    const history = await createRunHistory(fs, lockfile, dir, file);
    try {
      // Claimed by renaming it to a history of this pass: a pass that renames it second finds it gone.
      const claimed = await fs.rename(path, history.path).then(
        () => true,
        () => false,
      );
      if (!claimed) continue;
      await fs.remove(`${path}.lock`);
      outcomes.push(await postPass(opts, graph, owed, history, store));
      if (owedPosts(graph, history).size === 0) await fs.remove(history.path);
    } finally {
      await history.close();
    }
  }
  return outcomes;
}

export async function runWorkflow(opts: RunOptions): Promise<RunOutcome> {
  const store =
    opts.store ?? createGithubStore(opts.ports, { ...opts, durationsFile: durationsFileOf(opts) });
  opts.signal?.addEventListener("abort", store.cancel, { once: true });
  const { ports } = opts;
  const { ctx, full } = await buildGraph(opts);
  const graph = selectNodes(full, opts.only?.length ? opts.only : undefined);
  // Runs that stopped before their post pass owe their posts; this run pays them first. While one
  // still fails, what it set up may still be there, so no node of this run starts.
  const debts = await settle(opts, full, store);
  const unpaid = debts.reduce((n, outcome) => n + outcome.failed, 0);
  if (unpaid > 0) {
    ports.host.annotate(
      "error",
      "dag",
      `No task ran: post steps that an earlier run owes failed again (${unpaid}), and what they ` +
        `release may still be there. Fix them and run again, or, once it is gone, remove that ` +
        `run's history in ${opts.historyDir ?? DEFAULT_HISTORY_DIR}.`,
    );
    return runOutcomeOf({
      results: debts.flatMap((outcome) => outcome.results),
      failed: unpaid,
      markdown: debts.map((outcome) => outcome.markdown).join(""),
      cancelled: false,
    });
  }
  const total = full.describe().length;
  const nodes = graph.describe();
  const names = nodes.map((node) => node.name);
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
    nodes,
    ...(rerunCommand && { rerunCommand }),
  };
  store.begin(pass);
  await ports.fs.ensureDir(opts.cacheDir);
  const history = await createRunHistory(
    ports.fs,
    ports.lockfile,
    opts.historyDir ?? DEFAULT_HISTORY_DIR,
    {
      workflow: workflowOf(opts),
      ...(opts.only?.length && { only: opts.only }),
      started: [],
      results: {},
    },
  );
  const saves = savesOf(graph);
  let results: NodeResult[];
  try {
    await history.begin();
    results = await execute(
      graph,
      {
        ports,
        fs: ports.fs,
        cacheDir: opts.cacheDir,
        clock: ports.clock,
        startTimer: startGlobalTimer,
        ...(opts.force && { forcedKeys: "all" }),
      },
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
    if (owedPosts(graph, history).size === 0) await ports.fs.remove(history.path);
  } finally {
    await history.close();
  }
  // Only the run's own pass writes them: a debt's pass comes before the restore that may bring them.
  await store.writeDurations();
  const { failed, markdown } = await finishPass(ports, store, pass, results, opts.summary);
  return runOutcomeOf({ results, failed, markdown, cancelled: opts.signal?.aborted ?? false });
}

/** A node's result as the run's history recorded it, replayed so the engine feeds its outputs to the post steps. */
function replay(name: string, recorded: NodeResult | undefined): NodeResult {
  return recorded ?? { name, status: "cancelled" };
}

/**
 * The action's `post:`, and `dag run`'s after a cancel: run the post steps that runs no
 * longer going owe, with what they depend on replayed from each run's history so the engine's
 * dependency rules apply as they would have. A run whose post steps all succeeded owes nothing
 * and leaves no history, so nothing runs after it.
 */
export async function runPost(opts: PostOptions): Promise<RunOutcome> {
  const store =
    opts.store ?? createGithubStore(opts.ports, { ...opts, durationsFile: durationsFileOf(opts) });
  const { full } = await buildGraph(opts);
  const outcomes = await settle(opts, full, store);
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
async function postPass(
  opts: PostOptions,
  graph: Graph<Ports>,
  owed: Set<string>,
  history: Awaited<ReturnType<typeof createRunHistory>>,
  store: RunStore,
): Promise<RunOutcome> {
  const { ports } = opts;
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
  const executionContext = {
    ports,
    fs: ports.fs,
    cacheDir: opts.cacheDir,
    clock: ports.clock,
    startTimer: startGlobalTimer,
  };
  const runOwed = runNode(replayed, executionContext, {
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
      owed.has(node.name)
        ? runOwed(node, depDetails, waitForScheduler)
        : Promise.resolve(replay(node.name, before[node.name])),
    throttledScheduler(opts.schedulerOptions),
    ports.clock,
    (event) => {
      if (!owed.has(event.node)) return;
      store.onEvent(event);
      return history.onEvent(event);
    },
  );
  await history.flush();
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
