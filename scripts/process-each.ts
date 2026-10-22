/**
 * For the workflow tests: what a node declares is no longer on the graph's data, so they read it
 * from processing. Each node is processed on its own, in the order it was added, under `ports`
 * and a fresh cache, its deps' entries those of the nodes processed before it.
 */
import { MemCache, processNode, type CacheEntry, type Graph, type Result } from "@mrmeku/dagraph";
import type { Ports } from "@mrmeku/dagworkflows";

export const CAS = "/cas";

/** What processing one node showed: its result, the files outside the CAS its key hashed, and the commands it ran. */
export interface Processed {
  result: Result;
  files: string[];
  commands: string[][];
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
    // A file outside the CAS is an input, hashed alike whatever it holds.
    const fs = {
      ...ports.fs,
      hashFile: async (path: string) =>
        path.startsWith(`${CAS}/`) ? ports.fs.hashFile(path) : (files.push(path), ""),
    };
    const exec: Ports["exec"] = {
      run: (cmd, opts) => (commands.push(cmd), ports.exec.run(cmd, opts)),
    };
    const depEntries = Object.fromEntries(
      node.deps.flatMap((dep) => (entries[dep] ? [[dep, entries[dep]]] : [])),
    );
    const result = await processNode(graph, node.name, depEntries, {
      ports: { ...ports, fs, exec },
      cache: new MemCache(),
      fs,
      casBaseDir: CAS,
    });
    if (result.status === "done" || result.status === "cached")
      entries[node.name] = { outputs: result.outputs, contentHash: result.contentHash };
    processed.set(node.name, { result, files, commands });
  }
  return processed;
}
