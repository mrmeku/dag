/**
 * For the workflow tests: what a node declares is no longer on the graph's data, so they read it
 * from processing. Each node is processed on its own, in the order it was added, under `ports`
 * and a fresh cache, its deps' entries those of the nodes processed before it.
 */
import type { Ports } from "@mrmeku/dagactions";
import {
  MemCache,
  namedOutput,
  processNode,
  type CacheEntry,
  type Graph,
  type Result,
} from "@mrmeku/dagraph";

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
    const sh: Ports["sh"] = { run: (cmd, opts) => (commands.push(cmd), ports.sh.run(cmd, opts)) };
    const depEntries = Object.fromEntries(
      node.deps.flatMap((dep) => (entries[dep] ? [[dep, entries[dep]]] : [])),
    );
    const result = await processNode(graph, node.name, depEntries, {
      ports: { ...ports, fs, sh },
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

/** What a run step's `result.json` says it ran: its command as configured, and its cwd. */
export async function commandOf(
  ports: Ports,
  result: Result | undefined,
): Promise<{ cmd: string[]; cwd: string } | undefined> {
  if (result?.status !== "done") return undefined;
  const path = namedOutput(result.outputs, "result");
  const ran: unknown = JSON.parse(await ports.fs.readText(path));
  if (!isCommand(ran)) throw new Error(`${path} is not a run step's result.json`);
  return ran;
}

const isCommand = (value: unknown): value is { cmd: string[]; cwd: string } =>
  typeof value === "object" &&
  value !== null &&
  "cmd" in value &&
  Array.isArray(value.cmd) &&
  value.cmd.every((arg) => typeof arg === "string") &&
  "cwd" in value &&
  typeof value.cwd === "string";
