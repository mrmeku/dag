import {
  isNodeResult,
  type ExecutionEvent,
  type FileSystem,
  type NodeResult,
} from "@mrmeku/dagraph";
import { dirname } from "node:path";
import { lockOptions, type Lockfile } from "../lock/index.ts";

/** Each settled node's result: what a later process needs to feed its dependents. */
export type RunHistory = Record<string, NodeResult>;

/**
 * A run's history file: its workflow file (resolved; empty when none was named) and `--only`, so
 * a later pass of the same workflow rebuilds the graph it ran; the nodes whose start it recorded,
 * before their action could run, in that order, so a run killed mid-action still shows what it
 * owes; and its settled nodes' results.
 */
export interface RunHistoryFile {
  workflow: string;
  only?: string[];
  started: string[];
  results: RunHistory;
}

/**
 * Whether the run whose history is at `path` still runs: it holds a lock beside its history,
 * which it refreshes while it runs and releases when it exits, and which goes stale once a kill
 * stops it. The lock holds across processes, containers and hosts sharing the history.
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
  fs: FileSystem,
  lockfile: Lockfile,
  dir: string,
  initial: RunHistoryFile,
) {
  const path = `${dir}/${crypto.randomUUID()}.json`;
  await fs.ensureDir(dir);
  // A lost lock is a warning and the run goes on: at worst a later pass takes it for stopped.
  const release = await lockfile.lock(path, lockOptions(path));
  const history: RunHistoryFile = {
    ...initial,
    started: [...initial.started],
    results: { ...initial.results },
  };
  let latestWrite = Promise.resolve();
  const saveHistory = () => {
    latestWrite = latestWrite.then(async () => {
      const stagedHistoryFile = `${path}.${crypto.randomUUID()}.tmp`;
      await fs.writeText(stagedHistoryFile, JSON.stringify(history, null, 2));
      await fs.rename(stagedHistoryFile, path);
    });
    return latestWrite;
  };
  return {
    path,
    results: history.results,
    started: history.started,
    begin: saveHistory,
    /**
     * Records a start or a result. For a start it returns the write, which the engine awaits before
     * the action may run, so a run killed after its command started still shows what it owes.
     */
    onEvent: (event: ExecutionEvent): Promise<void> | undefined => {
      if (event.type === "start") history.started.push(event.node);
      else if (event.type === "result") history.results[event.node] = event.result;
      else return undefined;
      return saveHistory();
    },
    flush: () => latestWrite,
    // A lost lock was the warning already: its release has nothing left to free.
    close: () =>
      release().catch((e: unknown) => {
        if (!(e instanceof Error && "code" in e && e.code === "ERELEASED")) throw e;
      }),
  };
}

/** The history `createRunHistory` opens: it records the run's starts and results, and holds its lock until it is `close`d. */
export type OpenRunHistory = Awaited<ReturnType<typeof createRunHistory>>;

const isNames = (value: unknown) =>
  Array.isArray(value) && value.every((name) => typeof name === "string");

const isHistoryFile = (
  value: unknown,
): value is Omit<RunHistoryFile, "results"> & { results: object } =>
  typeof value === "object" &&
  value !== null &&
  "workflow" in value &&
  typeof value.workflow === "string" &&
  (!("only" in value) || isNames(value.only)) &&
  "started" in value &&
  isNames(value.started) &&
  "results" in value &&
  typeof value.results === "object" &&
  value.results !== null;

/**
 * The history at `path`. A result in an older shape is dropped, so its node replays as one that
 * never settled; the started nodes still say what the run owes.
 */
export async function readRunHistory(fs: FileSystem, path: string): Promise<RunHistoryFile> {
  const file: unknown = JSON.parse(await fs.readText(path));
  if (!isHistoryFile(file))
    throw new Error(
      typeof file === "object" && file !== null && !("started" in file)
        ? "it records no started nodes, as a history from before dag recorded them"
        : "not a run's history: it lacks its workflow, started nodes or results",
    );
  const results = Object.entries(file.results).flatMap(([name, result]): [string, NodeResult][] =>
    isNodeResult(result) ? [[name, result]] : [],
  );
  return { ...file, results: Object.fromEntries(results) };
}

/** A history and its lock, removed. */
export async function removeHistory(fs: FileSystem, path: string): Promise<void> {
  await fs.remove(path);
  await fs.remove(lockOptions(path).lockfilePath);
}

/**
 * The histories in `dir` of runs no longer going: their lock released, or stale after a kill. A
 * write a killed run left half done is deleted on the way.
 */
export async function stoppedHistories(
  fs: FileSystem,
  lockfile: Lockfile,
  dir: string,
): Promise<string[]> {
  const stopped: string[] = [];
  for (const name of await fs.readdir(dir)) {
    const end = name.indexOf(".json") + ".json".length;
    if (end < ".json".length || name.endsWith(".lock")) continue;
    const path = `${dir}/${name.slice(0, end)}`;
    if (await runHistoryLive(lockfile, path)) continue;
    if (name.length > end) await fs.remove(`${dir}/${name}`);
    else stopped.push(path);
  }
  return stopped;
}

/**
 * The stopped history at `path` claimed by renaming it onto a fresh locked history of `file`, so
 * only one pass pays it: undefined when another claimed it first.
 */
export async function claimHistory(
  fs: FileSystem,
  lockfile: Lockfile,
  path: string,
  file: RunHistoryFile,
): Promise<OpenRunHistory | undefined> {
  const history = await createRunHistory(fs, lockfile, dirname(path), file);
  const claimed = await fs.rename(path, history.path).then(
    () => true,
    () => false,
  );
  if (!claimed) {
    await history.close();
    return undefined;
  }
  await fs.remove(lockOptions(path).lockfilePath);
  return history;
}

/**
 * The posts a run's history shows it owes, of `posts` (each post's main by its name): each whose
 * main's start it recorded, whatever came of it, and that has not succeeded. A main whose start
 * it never recorded, `dep-failed` or cancelled while queued, owes nothing. A post that failed
 * every try is still owed.
 */
export function owedPosts(
  { results, started }: Pick<RunHistoryFile, "results" | "started">,
  posts: ReadonlyMap<string, string>,
): Set<string> {
  return new Set(
    [...posts]
      .filter(([name, main]) => started.includes(main) && results[name]?.status !== "succeeded")
      .map(([name]) => name),
  );
}
