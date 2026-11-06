import {
  errorMessage,
  isMissingFileError,
  type ExecutionEvent,
  type FileSystem,
} from "@mrmeku/dagraph";
import { relative } from "node:path";
import { isDebugCommand, warningCommand } from "../github-workflow-commands/index.ts";
import {
  completedLines,
  groupLines,
  initialRunState,
  logLines,
  runReducer,
  selectors,
  settledWithLog,
  titleOf,
  type InFlightNodeState,
  type NodeReport,
  type NodeState,
  type Pass,
  type RunAction,
  type RunState,
  type SettledNodeState,
  type SucceededNodeState,
} from "../kernel/index.ts";

/** The run's data, as every summary renderer gets it. In the post pass it holds the owed post steps alone. */
export interface RunReport {
  /** In graph order, which is topological. */
  nodes: NodeReport[];
  /** A node's log as its group printed it: stdout, stderr, then a failure's error. */
  log: (name: string) => Promise<string[]>;
}

/**
 * The file a run keeps its workflow's durations in, in `dir`, named by the workflow file's path
 * from the working directory, a `..` in it encoded so the file stays in `dir`.
 */
export function durationsFileOf(dir: string, workflowFile: string | undefined): string {
  const workflow = workflowFile
    ? relative(".", workflowFile).replaceAll("..", "%2E%2E")
    : titleOf(undefined);
  return `${dir}/${workflow}.json`;
}

/** What a file read resolves to, `undefined` when nothing is there. */
const readIfThere = (fs: FileSystem, path: string) =>
  fs.readText(path).catch((e: unknown) => {
    if (isMissingFileError(e)) return undefined;
    throw e;
  });

/**
 * What a listener hears of the run. `begin`, `start`, `settle` and `finish` come in
 * the order they happened, each with the node as its action left it, a settle once its log is
 * read, so no pass begins ahead of the last one's settles; `run` is the state as it is by then.
 * `isFirstPass` is the store's first pass. `immediate` hears a node start and print at once, ahead
 * of settles still being read, inside the engine's emit and the command's data listener; one that
 * throws is rethrown on the ordered hooks' chain, as if one of them had thrown, and never breaks
 * the emit or the stream. `close` and `interrupt` come last listener first, so the first listener
 * has the last word.
 */
export interface RunListener {
  /** Called once, as the store is made: a listener that redraws on its own reads the state so. */
  attach?: (getState: () => RunState) => void;
  begin?: (pass: Pass, run: RunState, isFirstPass: boolean) => void;
  start?: (nodeState: InFlightNodeState, run: RunState) => void;
  settle?: (nodeState: SettledNodeState, run: RunState, log: string[]) => void;
  finish?: (pass: Pass, nodes: NodeReport[]) => void | Promise<void>;
  close?: (run: RunState) => void;
  interrupt?: (run: RunState) => void;
  immediate?: {
    start?: (nodeState: InFlightNodeState) => void;
    output?: (nodeState: NodeState, lines: string[]) => void;
  };
}

const isDurations = (value: unknown): value is Record<string, number> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((ms) => typeof ms === "number");

/**
 * The run every display reads: `runReducer`'s state, its listeners told of each action, each built
 * node's log in `buildLogDir` by action key (none kept without one), and the workflow's
 * `durationsFile`.
 */
export function createRunStore(opts: {
  fs: FileSystem;
  buildLogDir?: string | undefined;
  durationsFile: string;
  listeners: RunListener[];
}) {
  const { fs, buildLogDir, durationsFile, listeners } = opts;
  let state = initialRunState;
  const durations: Record<string, number> = {};
  /** What each node's attempt has printed, until its settle. */
  const attemptOutput = new Map<string, string>();
  let passCount = 0;
  let listenerQueue = Promise.resolve();
  const queueInOrder = (work: () => void | Promise<void>) => {
    listenerQueue = listenerQueue.then(work);
  };
  const runImmediately = (hook: () => void) => {
    try {
      hook();
    } catch (e) {
      queueInOrder(() => Promise.reject(e));
    }
  };
  const callClosingHooks = (hook: (listener: RunListener) => void) => {
    const errors = listeners.toReversed().flatMap((listener) => {
      try {
        hook(listener);
        return [];
      } catch (e) {
        return [e];
      }
    });
    if (errors.length > 0) throw errors[0];
  };

  const shownLines = (text: string) => logLines(text).filter((line) => !isDebugCommand(line));
  const buildLogPath = (dir: string, actionKey: string) => `${dir}/${actionKey}.log`;
  const buildLogWarning = (nodeName: string, error: unknown) =>
    warningCommand(
      nodeName,
      `its build log in ${buildLogDir} could not be written or read: ${errorMessage(error)}`,
    );
  /** The log of the build that made a node's entry; a missing one reads as empty. */
  const buildLogLines = async ({ node, result }: SucceededNodeState): Promise<string[]> => {
    if (buildLogDir === undefined) return [];
    try {
      return shownLines(
        (await readIfThere(fs, buildLogPath(buildLogDir, result.details.actionKey))) ?? "",
      );
    } catch (e) {
      return [buildLogWarning(node.name, e)];
    }
  };
  /** Renamed into place, so a hit never reads half of it; a build that printed nothing leaves none. */
  const keepBuildLog = async (buildLogDir: string, actionKey: string, output: string) => {
    const buildLog = buildLogPath(buildLogDir, actionKey);
    if (output === "") return fs.remove(buildLog);
    const stagedBuildLog = `${buildLog}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeText(stagedBuildLog, output);
      await fs.rename(stagedBuildLog, buildLog);
    } catch (e) {
      // A later hit then shows no log rather than an earlier build's.
      await Promise.all([fs.remove(stagedBuildLog), fs.remove(buildLog)]);
      throw e;
    }
  };
  /** What a settled node printed, or a hit's build log; a built node's is kept under its key. */
  const settleLog = async (nodeState: SettledNodeState, output: string): Promise<string[]> => {
    switch (nodeState.status) {
      case "succeeded":
        if (!nodeState.result.details.actionRan) return buildLogLines(nodeState);
        if (buildLogDir === undefined) return shownLines(output);
        try {
          await keepBuildLog(buildLogDir, nodeState.result.details.actionKey, output);
          return shownLines(output);
        } catch (e) {
          return [...shownLines(output), buildLogWarning(nodeState.node.name, e)];
        }
      case "failed":
      case "cancelled":
      case "dep-failed":
        return shownLines(output);
    }
  };
  let lookingForLastRun = true;
  const readLastRun = async () => {
    if (!lookingForLastRun) return;
    try {
      const text = await readIfThere(fs, durationsFile);
      if (text === undefined) return;
      const lastRun: unknown = JSON.parse(text);
      const lastRunDurations =
        typeof lastRun === "object" && lastRun !== null && "durations" in lastRun
          ? lastRun.durations
          : undefined;
      if (!isDurations(lastRunDurations)) return;
      lookingForLastRun = false;
      dispatch({ type: "lastRunRead", durations: lastRunDurations });
    } catch {
      // A file this version cannot read is no last run, and a later read may find another.
    }
  };
  const writeDurationsFile = async () => {
    if (Object.keys(durations).length === 0) return;
    // From here the file holds this run's durations, never its last run's.
    lookingForLastRun = false;
    const file = { durations: { ...state.lastRunDurations, ...durations } };
    await fs.writeText(durationsFile, JSON.stringify(file, null, 2));
  };

  const announceCompletedLines = (nodeState: NodeState, lines: string[]) => {
    if (lines.length > 0)
      for (const listener of listeners)
        runImmediately(() => listener.immediate?.output?.(nodeState, lines));
  };
  const settleNode = async (nodeState: SettledNodeState, output: string) => {
    const log = await settleLog(nodeState, output);
    await readLastRun();
    const duration = selectors.durationOf(nodeState);
    if (selectors.ranToItsEnd(nodeState.result) && duration !== undefined)
      durations[nodeState.node.name] = duration;
    const logRead = { type: "logRead", settled: nodeState, log } as const;
    dispatch(logRead);
    const settled = settledWithLog(nodeState, log);
    for (const listener of listeners) listener.settle?.(settled, state, log);
  };

  const dispatch = (action: RunAction) => {
    const previous = state;
    state = runReducer(state, action);
    switch (action.type) {
      case "passBegun": {
        const isFirstPass = passCount++ === 0;
        queueInOrder(() =>
          listeners.forEach((listener) => listener.begin?.(action.pass, state, isFirstPass)),
        );
        queueInOrder(readLastRun);
        return;
      }
      case "output": {
        const nodeState = state.nodes.get(action.node);
        if (!nodeState) return;
        attemptOutput.set(action.node, (attemptOutput.get(action.node) ?? "") + action.chunk);
        const unfinishedLine = previous.nodes.get(action.node)?.unfinishedLine ?? "";
        announceCompletedLines(nodeState, completedLines(unfinishedLine, action.chunk));
        return;
      }
      case "runCancelled":
      case "runClosed":
      case "runErrored":
      case "runInterrupted":
      case "lastRunRead":
      case "logRead":
        return;
    }
    const nodeState = state.nodes.get(action.node);
    if (!nodeState) return;
    if (nodeState.status === "running") {
      for (const listener of listeners)
        runImmediately(() => listener.immediate?.start?.(nodeState));
      queueInOrder(() => listeners.forEach((listener) => listener.start?.(nodeState, state)));
    } else if (selectors.isSettled(nodeState)) {
      // The command has exited: its last line ends with it.
      const unfinishedLine = previous.nodes.get(action.node)?.unfinishedLine;
      if (unfinishedLine) announceCompletedLines(nodeState, completedLines(unfinishedLine, "\n"));
      // Taken now: the node's next attempt, in a later pass, may print before this settle is read.
      const output = attemptOutput.get(action.node) ?? "";
      attemptOutput.delete(action.node);
      queueInOrder(() => settleNode(nodeState, output));
    }
  };

  const getState = (): RunState => state;
  for (const listener of listeners) listener.attach?.(getState);

  return {
    dispatch,
    getState,
    begin: (pass: Pass) => dispatch({ type: "passBegun", pass }),
    cancel: () => dispatch({ type: "runCancelled" }),
    onEvent: (event: ExecutionEvent) => dispatch(event),
    /** Writes this run's durations over its last run's; a failed write fails the next report. */
    writeDurations: (): Promise<void> => {
      queueInOrder(writeDurationsFile);
      return listenerQueue.catch(() => {});
    },
    /** `pass`'s nodes, once every settle is told. */
    report: async (pass: Pass): Promise<NodeReport[]> => {
      await listenerQueue;
      return selectors.nodeReports(state, pass.nodes);
    },
    /** A node's log as its group prints it. */
    log: async (name: string): Promise<string[]> => {
      const nodeState = state.nodes.get(name);
      if (!nodeState || !selectors.isSettled(nodeState)) return [];
      return groupLines(nodeState, nodeState.log ?? []);
    },
    finish: (pass: Pass, reports: NodeReport[]) => {
      queueInOrder(async () => {
        for (const listener of listeners) await listener.finish?.(pass, reports);
      });
      return listenerQueue;
    },
    close: async (error?: unknown) => {
      // Only a run that threw already rejects here, and `error` is that run's own.
      await listenerQueue.catch(() => {});
      dispatch(
        error === undefined
          ? { type: "runClosed" }
          : { type: "runErrored", error: errorMessage(error) },
      );
      callClosingHooks((listener) => listener.close?.(state));
    },
    interrupt: () => {
      dispatch({ type: "runInterrupted" });
      callClosingHooks((listener) => listener.interrupt?.(state));
    },
  };
}

export type RunStore = ReturnType<typeof createRunStore>;
