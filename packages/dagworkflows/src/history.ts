import { isResult, type DagFs, type ExecEvent, type Result } from "@mrmeku/dagraph";
import { HISTORY_LOCK_STALE_MS } from "./config.ts";
import type { Lockfile } from "./ports.ts";

/** Each settled node's result: what a later process needs to feed its dependents. */
export type RunHistory = Record<string, Result>;

/**
 * A run's history file: its workflow file (resolved; empty when none was named) and `--only`, so
 * a later pass of the same workflow rebuilds the graph it ran; the nodes whose action started, in
 * the order they started, so a run killed mid-action still shows what it owes; and its settled
 * nodes' results.
 */
export interface RunHistoryFile {
  workflow: string;
  only?: string[];
  started: string[];
  results: RunHistory;
}

const lockOptions = (path: string) => ({
  lockfilePath: `${path}.lock`,
  realpath: false,
  stale: HISTORY_LOCK_STALE_MS,
});

/**
 * Whether the run whose history is at `path` still runs: it holds a lock beside its history,
 * which it refreshes while it runs and releases when it exits, and which goes stale once a kill
 * stops it. The lock is a directory, so it holds across processes, containers and hosts sharing
 * the history.
 */
export const runHistoryLive = (lockfile: Lockfile, path: string): Promise<boolean> =>
  lockfile.check(path, lockOptions(path));

/**
 * A run's own history in `dir`, so runs at the same time never write one file: every node that
 * settled, written as nodes settle, so a run the runner interrupts or kills still leaves a
 * consistent record. Each write goes beside the file and is renamed over it, so a write a kill
 * cuts short leaves the last whole one. The run holds its history's lock until it is `close`d;
 * a history it left then shows a later pass what it still owes.
 */
export async function createRunHistory(
  fs: DagFs,
  lockfile: Lockfile,
  dir: string,
  initial: RunHistoryFile,
) {
  const path = `${dir}/${crypto.randomUUID()}.json`;
  await fs.ensureDir(dir);
  const release = await lockfile.lock(path, {
    ...lockOptions(path),
    // The run goes on: at worst a later pass takes it for stopped and settles its posts.
    onCompromised: (e) => process.emitWarning(`the lock on ${path} was lost: ${e.message}`),
  });
  const history: RunHistoryFile = {
    ...initial,
    started: [...initial.started],
    results: { ...initial.results },
  };
  let chain = Promise.resolve();
  const saveHistory = () => {
    chain = chain.then(async () => {
      const written = `${path}.${crypto.randomUUID()}.tmp`;
      await fs.writeText(written, JSON.stringify(history, null, 2));
      await fs.rename(written, path);
    });
    return chain;
  };
  return {
    path,
    results: history.results,
    started: history.started,
    begin: saveHistory,
    /**
     * Records a start or a result. For a start it returns the write, which the engine awaits before
     * the action runs, so a run killed after its command started still shows what it owes.
     */
    onEvent: (event: ExecEvent): Promise<void> | undefined => {
      if (event.type === "start") history.started.push(event.node);
      else if (event.type === "result") history.results[event.node] = event.result;
      else return undefined;
      return saveHistory();
    },
    flush: () => chain,
    close: release,
  };
}

const isNames = (value: unknown) =>
  Array.isArray(value) && value.every((name) => typeof name === "string");

const isHistoryFile = (value: unknown): value is RunHistoryFile =>
  typeof value === "object" &&
  value !== null &&
  "workflow" in value &&
  typeof value.workflow === "string" &&
  (!("only" in value) || isNames(value.only)) &&
  "started" in value &&
  isNames(value.started) &&
  "results" in value &&
  typeof value.results === "object" &&
  value.results !== null &&
  Object.values(value.results).every(isResult);

export async function readRunHistory(fs: DagFs, path: string): Promise<RunHistoryFile> {
  const file: unknown = JSON.parse(await fs.readText(path));
  if (!isHistoryFile(file))
    throw new Error(
      typeof file === "object" && file !== null && !("started" in file)
        ? "it records no started nodes, as a history from before dag recorded them"
        : "not a run's history: it lacks its workflow, started nodes or results",
    );
  return file;
}
