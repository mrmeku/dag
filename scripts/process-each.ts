/**
 * For the workflow tests: what a node declares is no longer on the graph's data, so they read it
 * from processing. Each node is processed on its own, in the order it was added, under `ports`,
 * with its cache at `CACHE_DIR` in their fs, its deps' entries those of nodes processed before it.
 */
import {
  isSucceeded,
  lookupOrRunNode,
  startGlobalTimer,
  wallClock,
  type CacheEntry,
  type Graph,
  type NodeResult,
} from "@mrmeku/dagraph";
import type { Ports } from "@mrmeku/dagworkflows";

const CACHE_DIR = "/cache";

/** What processing one node showed: its result, the files outside the cache dir its key hashed, the commands it ran and what it printed. */
export interface Processed {
  result: NodeResult;
  files: string[];
  commands: string[][];
  log: string;
}

export async function processEach(
  graph: Graph<Ports>,
  ports: Ports,
): Promise<Map<string, Processed>> {
  const entries: Record<string, CacheEntry> = {};
  const processed = new Map<string, Processed>();
  for (const node of graph.describe()) {
    const files: string[] = [];
    const commands: string[][] = [];
    // A file outside the cache dir is an input, hashed alike whatever it holds.
    const fs = {
      ...ports.fs,
      hashFile: async (path: string) =>
        path.startsWith(`${CACHE_DIR}/`) ? ports.fs.hashFile(path) : (files.push(path), ""),
    };
    const exec: Ports["exec"] = {
      run: (cmd, opts) => (commands.push(cmd), ports.exec.run(cmd, opts)),
    };
    const depEntries = Object.fromEntries(
      node.deps.flatMap((dep) => (entries[dep] ? [[dep, entries[dep]]] : [])),
    );
    const context = {
      ports: { ...ports, fs, exec },
      fs,
      cacheDir: CACHE_DIR,
      clock: wallClock,
      startTimer: startGlobalTimer,
    };
    let log = "";
    const result = await lookupOrRunNode(graph, node.name, depEntries, context, {
      onEvent: (event) => {
        if (event.type === "output") log += event.chunk;
      },
    });
    if (isSucceeded(result)) entries[node.name] = result.details.entry;
    processed.set(node.name, { result, files, commands, log });
  }
  return processed;
}
