import { isOutputs, type DagFs, type ExecEvent, type Outputs } from "@mrmeku/dagraph";
import { HISTORY_LOCK_STALE_MS } from "./config.ts";
import type { Lockfile } from "./ports.ts";

/** One settled node's result: what a later process needs to feed its dependents. */
export type RunHistoryEntry =
  | { status: "done" | "cached"; outputs: Outputs; contentHash: string }
  | { status: "failed" | "cancelled" }
  | { status: "dep-failed"; dep: string };

export type RunHistory = Record<string, RunHistoryEntry>;

/**
 * A run's history file: its workflow file (resolved; empty when none was named) and `--only`, so
 * a later pass of the same workflow rebuilds the graph it ran, and its settled nodes.
 */
export interface RunHistoryFile {
  workflow: string;
  only?: string[];
  nodes: RunHistory;
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
  const entries: RunHistory = { ...initial.nodes };
  let chain = Promise.resolve();
  const write = () => {
    chain = chain.then(async () => {
      const written = `${path}.${crypto.randomUUID()}.tmp`;
      await fs.writeText(written, JSON.stringify({ ...initial, nodes: entries }, null, 2));
      await fs.rename(written, path);
    });
    return chain;
  };
  return {
    path,
    entries,
    begin: write,
    onEvent: (ev: ExecEvent) => {
      if (ev.type !== "result") return;
      const result = ev.result;
      switch (result.status) {
        case "done":
        case "cached":
          entries[ev.node] = {
            status: result.status,
            outputs: result.outputs,
            contentHash: result.contentHash,
          };
          break;
        case "dep-failed":
          entries[ev.node] = { status: "dep-failed", dep: result.dep };
          break;
        default:
          entries[ev.node] = { status: result.status };
      }
      void write();
    },
    flush: () => chain,
    close: release,
  };
}

const isHistoryEntry = (value: unknown): value is RunHistoryEntry => {
  if (typeof value !== "object" || value === null || !("status" in value)) return false;
  switch (value.status) {
    case "done":
    case "cached":
      return (
        "outputs" in value &&
        isOutputs(value.outputs) &&
        "contentHash" in value &&
        typeof value.contentHash === "string"
      );
    case "dep-failed":
      return "dep" in value && typeof value.dep === "string";
    default:
      return value.status === "failed" || value.status === "cancelled";
  }
};

const isHistoryFile = (value: unknown): value is RunHistoryFile =>
  typeof value === "object" &&
  value !== null &&
  "workflow" in value &&
  typeof value.workflow === "string" &&
  (!("only" in value) ||
    (Array.isArray(value.only) && value.only.every((n) => typeof n === "string"))) &&
  "nodes" in value &&
  typeof value.nodes === "object" &&
  value.nodes !== null &&
  Object.values(value.nodes).every(isHistoryEntry);

export async function readRunHistory(fs: DagFs, path: string): Promise<RunHistoryFile> {
  const file: unknown = JSON.parse(await fs.readText(path));
  if (!isHistoryFile(file)) throw new Error("not a run's history: it has no nodes, or no workflow");
  return file;
}
