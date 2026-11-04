import { expect, test } from "bun:test";

import type { CacheEntry } from "../cache/index.ts";
import { createMemoryFileSystem, type MemoryFileSystem } from "../filesystem/index.ts";
import { actionsFor, dep, Graph, nodeInputs, type ActionContext } from "../graph/index.ts";
import { lookupNode, lookupOrRunNode, type ExecutionContext } from "./index.ts";

interface Ports {
  fs: MemoryFileSystem;
  ran: string[];
}

async function emit(c: ActionContext<Ports>, kind: string, content: string) {
  c.ports.ran.push(kind);
  const path = `${c.outputDir}/${kind}.txt`;
  await c.ports.fs.writeText(path, content);
  return { content: path };
}

const defineActionWithPorts = actionsFor<Ports>();
const source = defineActionWithPorts({
  kind: "source",
  nodeInputs: nodeInputs<{ video: string }>,
  action: async (c) => emit(c, "source", "abc"),
});
const transcript = (version: number) =>
  defineActionWithPorts({
    kind: "transcript",
    deps: { source },
    inputs: { version },
    action: async (c) =>
      emit(c, "transcript", `words(${await c.depOutputs.source.content.text()})`),
  });
const packaged = defineActionWithPorts({
  kind: "packaged",
  deps: { source },
  action: async (c) => emit(c, "packaged", `pkg(${await c.depOutputs.source.content.text()})`),
});
const entry = defineActionWithPorts({
  kind: "entry",
  deps: { transcript: dep<{ content: string }>, packaged },
  action: async (c) =>
    emit(
      c,
      "entry",
      `${await c.depOutputs.transcript.content.text()}+${await c.depOutputs.packaged.content.text()}`,
    ),
});
const uploaded = defineActionWithPorts({
  kind: "uploaded",
  deps: { entry },
  cacheable: false,
  action: async (c) => emit(c, "uploaded", "id"),
});

/** source -> {transcript, packaged} -> entry -> uploaded. */
function buildGraph(transcriptVersion = 1) {
  const g = new Graph<Ports>();
  const src = source.addNode(g, { inputs: { video: "abc" } });
  const t = transcript(transcriptVersion).addNode(g, { deps: { source: src } });
  const pk = packaged.addNode(g, { deps: { source: src } });
  const e = entry.addNode(g, { deps: { transcript: t, packaged: pk } });
  uploaded.addNode(g, { deps: { entry: e } });
  return g;
}

test("lookupNode looks a node up without running it: a node without a verified entry is a miss, a cacheable: false one too", async () => {
  const ports: Ports = { fs: createMemoryFileSystem(), ran: [] };
  const ctx: ExecutionContext<Ports> = {
    ports,
    fs: ports.fs,
    cacheDir: "/cache",
    clock: { epochMilliseconds: () => 0 },
    startTimer: () => () => {},
  };
  // Each node of the first graph looked up or run in turn, its deps' entries by name.
  const entries: Record<string, CacheEntry> = {};
  const first = buildGraph();
  for (const { name } of first.describe()) {
    const result = await lookupOrRunNode(first, name, entries, ctx);
    if (result.status === "succeeded") entries[name] = result.details.entry;
  }
  const lookups = async (graph: Graph<Ports>) => {
    const looked = graph.describe().map(async ({ name }) => {
      const found = await lookupNode(graph, name, entries, ctx);
      return [name, found.status === "succeeded" ? "hit" : found.status] as const;
    });
    return Object.fromEntries(await Promise.all(looked));
  };
  ports.ran = [];
  expect({
    changed: await lookups(buildGraph(2)),
    unchanged: await lookups(buildGraph()),
    ran: ports.ran,
  }).toEqual({
    changed: {
      source: "hit",
      transcript: "missed",
      packaged: "hit",
      entry: "hit",
      uploaded: "missed",
    },
    unchanged: {
      source: "hit",
      transcript: "hit",
      packaged: "hit",
      entry: "hit",
      uploaded: "missed",
    },
    ran: [],
  });
});
