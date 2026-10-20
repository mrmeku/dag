import type { ExecEvent } from "@mrmeku/dagraph";
import { LAST_RUN_FILE } from "../config.ts";
import type { Ports } from "../ports.ts";
import { logPath } from "../step-records.ts";
import { errorMessage, groupLines, isDebugCommand, logLines } from "./format.ts";
import type { NodeReport } from "./report.ts";
import {
  completedLines,
  initialRunState,
  nodeReducer,
  runReducer,
  type InFlightNodeState,
  type NodeState,
  type Pass,
  type RunAction,
  type RunState,
  type SettledNodeState,
} from "./run-slice.ts";
import * as selectors from "./selectors.ts";

/**
 * What a renderer or recorder hears of the run. `begin`, `start`, `settle` and `finish` come in
 * the order they happened, each with the node as its action left it, a settle once its CAS log is
 * read, so no pass begins ahead of the last one's settles; `run` is the state as it is by then.
 * `isFirstPass` is the store's first pass. `immediate` hears a node start and print at once, ahead
 * of settles still being read, inside the engine's emit and the command's data listener; one that
 * throws is rethrown on the ordered hooks' chain, as if one of them had thrown, and never breaks
 * the emit or the stream. `close` and `interrupt` come last listener first, so the first listener
 * has the last word.
 */
export interface RunListener {
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

/**
 * The run every output reads: `runReducer`'s state, and its listeners told of each action. Its IO
 * is the CAS: a settled node's log, and last-run.json, read before its first write (a node may
 * restore the CAS that holds it) or, given `lastRunAtBegin`, as the run begins, and written as
 * nodes settle, so a CAS saved in the graph carries it.
 */
export function createRunStore(
  opts: Pick<Ports, "fs" | "clock"> & {
    casBaseDir: string;
    listeners: RunListener[];
    lastRunAtBegin?: boolean;
  },
) {
  const { fs, casBaseDir, listeners } = opts;
  let state = initialRunState;
  const durations: Record<string, number> = {};
  let passCount = 0;
  let listenerQueue = Promise.resolve();
  const queueInOrder = (work: () => void | Promise<void>) =>
    (listenerQueue = listenerQueue.then(work));
  const runImmediately = (hook: () => void) => {
    try {
      hook();
    } catch (e) {
      queueInOrder(() => Promise.reject(e));
    }
  };
  const tearDownListeners = (hook: (listener: RunListener) => void) => {
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

  const casLogLines = async (actionKey: string | undefined): Promise<string[]> => {
    const path = actionKey && logPath(casBaseDir, actionKey);
    if (!path || !(await fs.exists(path))) return [];
    return logLines(await fs.readText(path)).filter((line) => !isDebugCommand(line));
  };
  const lastRunPath = `${casBaseDir}/${LAST_RUN_FILE}`;
  let lastRunRead: Promise<void> | undefined;
  const readLastRun = () =>
    (lastRunRead ??= (async () => {
      if (!(await fs.exists(lastRunPath))) return;
      try {
        const { durations } = JSON.parse(await fs.readText(lastRunPath));
        dispatch({ type: "lastRunRead", durations });
      } catch {
        // A file this version cannot read is a run with no last run.
      }
    })());
  const writeLastRun = async () => {
    await readLastRun();
    await fs.ensureDir(casBaseDir);
    const last = { durations: { ...state.lastRunDurations, ...durations } };
    await fs.writeText(lastRunPath, JSON.stringify(last, null, 2));
  };

  const announceCompletedLines = (nodeState: NodeState, lines: string[]) => {
    if (lines.length > 0)
      for (const listener of listeners)
        runImmediately(() => listener.immediate?.output?.(nodeState, lines));
  };
  const settleNode = async (nodeState: SettledNodeState) => {
    const log = await casLogLines(selectors.actionKeyOf(nodeState));
    const duration = selectors.durationOf(nodeState);
    if ((nodeState.status === "done" || nodeState.status === "failed") && duration !== undefined) {
      durations[nodeState.node.name] = duration;
      await writeLastRun();
    }
    const logRead = { type: "logRead", settled: nodeState, log } as const;
    dispatch(logRead);
    const settled = nodeReducer(nodeState, logRead) as SettledNodeState;
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
        if (opts.lastRunAtBegin) queueInOrder(readLastRun);
        return;
      }
      case "output": {
        const unfinishedLine = previous.nodes.get(action.node)?.unfinishedLine ?? "";
        const nodeState = state.nodes.get(action.node);
        if (nodeState)
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
      queueInOrder(() => settleNode(nodeState));
    }
  };

  return {
    dispatch,
    getState: (): RunState => state,
    begin: (pass: Pass) => dispatch({ type: "passBegun", pass }),
    cancel: () => dispatch({ type: "runCancelled" }),
    onEvent: (event: ExecEvent) =>
      dispatch(event.type === "output" ? event : { ...event, occurredAt: opts.clock.now() }),
    /** `pass`'s nodes, once every settle is told and the last run's durations are known. */
    report: async (pass: Pass): Promise<NodeReport[]> => {
      await listenerQueue;
      await readLastRun();
      // A restore that a cancel caught settles untimed, and may have replaced the file since.
      if (Object.keys(durations).length > 0) await writeLastRun();
      return selectors.nodeReports(state, pass.nodes);
    },
    /** A node's log as its group prints it, read back from the CAS. */
    log: async (name: string): Promise<string[]> => {
      const nodeState = state.nodes.get(name);
      return nodeState
        ? groupLines(
            nodeState,
            (nodeState.status === "failed" ? nodeState.log : undefined) ??
              (await casLogLines(selectors.actionKeyOf(nodeState))),
          )
        : [];
    },
    finish: (pass: Pass, reports: NodeReport[]) =>
      queueInOrder(async () => {
        for (const listener of listeners) await listener.finish?.(pass, reports);
      }),
    close: async (error?: unknown) => {
      // Only a run that threw already rejects here, and `error` is that run's own.
      await listenerQueue.catch(() => {});
      dispatch(
        error === undefined
          ? { type: "runClosed" }
          : { type: "runErrored", error: errorMessage(error) },
      );
      tearDownListeners((listener) => listener.close?.(state));
    },
    interrupt: () => {
      dispatch({ type: "runInterrupted" });
      tearDownListeners((listener) => listener.interrupt?.(state));
    },
  };
}

export type RunStore = ReturnType<typeof createRunStore>;
