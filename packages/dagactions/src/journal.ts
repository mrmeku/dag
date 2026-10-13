import type { DagFs, ExecEvent, Outputs } from "@mrmeku/dagraph";

/** One settled node: what a later process needs to feed its dependents. */
export type JournalEntry =
  | { status: "done" | "cached"; outputs: Outputs; contentHash: string }
  | { status: "fail" | "dep-failed" | "cancelled" };

export type Journal = Record<string, JournalEntry>;

/**
 * Every settled node of a run, written to disk as nodes settle, so a run the runner interrupts
 * or kills still leaves a consistent record. `dagactions post` reads it to find the post steps the
 * run did not reach, and adds what it ran, so a second pass finds nothing. `begin` writes the
 * initial entries: a run begins with none, so a stale journal never feeds a post pass.
 */
export function createJournal(fs: DagFs, path: string, initial: Journal = {}) {
  const entries: Journal = { ...initial };
  let chain = Promise.resolve();
  const write = () => {
    chain = chain.then(async () => {
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (dir) await fs.ensureDir(dir);
      await fs.writeText(path, JSON.stringify(entries, null, 2));
    });
    return chain;
  };
  return {
    begin: write,
    onEvent: (ev: ExecEvent) => {
      switch (ev.type) {
        case "done":
        case "cached":
          entries[ev.node.name] = {
            status: ev.type,
            outputs: ev.outputs,
            contentHash: ev.contentHash,
          };
          break;
        case "fail":
        case "dep-failed":
        case "cancelled":
          entries[ev.node.name] = { status: ev.type };
          break;
        default:
          return;
      }
      void write();
    },
    flush: () => chain,
  };
}

export async function readJournal(fs: DagFs, path: string): Promise<Journal> {
  return (await fs.exists(path)) ? (JSON.parse(await fs.readText(path)) as Journal) : {};
}
