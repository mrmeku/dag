import { expect, test } from "bun:test";
import assert from "node:assert/strict";

import type { CacheEntry } from "../cache/index.ts";
import { createMemoryFileSystem, type MemoryFileSystem } from "../filesystem/index.ts";
import { actionsFor, dep, Graph, nodeInputs, settled, type ActionContext } from "../graph/index.ts";
import { errorMessage } from "../orchestration/index.ts";
import {
  lookupNode,
  lookupOrRunNode,
  resultActionKey,
  type ExecutionContext,
  type NodeResult,
} from "./index.ts";

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

const clock = { epochMilliseconds: () => 0 };
const startTimer = () => () => {};

function setup() {
  const ports: Ports = { fs: createMemoryFileSystem(), ran: [] };
  const ctx: ExecutionContext<Ports> = {
    ports,
    fs: ports.fs,
    cacheDir: "/cache",
    clock,
    startTimer,
  };
  return { ports, ctx };
}

/** Each node of `graph` looked up or run in turn, given the entries of its deps that succeeded. */
async function runInTurn(graph: Graph<Ports>, ctx: ExecutionContext<Ports>) {
  const entries: Record<string, CacheEntry> = {};
  const results: NodeResult[] = [];
  for (const { name } of graph.describe()) {
    const result = await lookupOrRunNode(graph, name, entries, ctx);
    if (result.status === "succeeded") entries[name] = result.details.entry;
    results.push(result);
  }
  return { entries, results };
}

test("lookupNode looks a node up without running it: a node without a verified entry is a miss, a cacheable: false one too", async () => {
  const { ports, ctx } = setup();
  const { entries } = await runInTurn(buildGraph(), ctx);
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

const download = defineActionWithPorts({
  kind: "download",
  nodeInputs: nodeInputs<{ videoId: string }>,
  action: async (c) => emit(c, "download", `audio of ${c.inputs.videoId}`),
});
const captions = defineActionWithPorts({
  kind: "captions",
  deps: { download },
  action: async (): Promise<{ vtt: string }> => {
    throw new Error("no captions");
  },
});
const videoEntry = defineActionWithPorts({
  kind: "video entry",
  deps: { download, captions: settled(captions) },
  cacheable: false,
  action: async (c) => emit(c, "video entry", "{}"),
});

/** One video's nodes, added through its subgraph. */
function addVideo(g: Graph<Ports>, videoId: string) {
  const v = g.subgraph(videoId);
  const dl = download.addNode(v, { inputs: { videoId } });
  const cc = captions.addNode(v, { deps: { download: dl } });
  videoEntry.addNode(v, { deps: { download: dl, captions: settled(cc) } });
}

test("lookupOrRunNode finds a node by name in any graph that declares it the same way, and refuses a name the graph does not hold", async () => {
  const { ctx } = setup();
  const whole = new Graph<Ports>();
  addVideo(whole, "v1");
  addVideo(whole, "v2");
  const { entries, results } = await runInTurn(whole, ctx);
  const oneVideo = new Graph<Ports>();
  addVideo(oneVideo, "v2");
  const viaOneVideo = await lookupOrRunNode(oneVideo, "v2:download", {}, ctx);
  const failedDep = await lookupOrRunNode(oneVideo, "v2:captions", {}, ctx);
  const downloadEntry = entries["v2:download"];
  assert.ok(downloadEntry, "v2:download's entry");
  const settledMissing = await lookupOrRunNode(
    oneVideo,
    "v2:video entry",
    { "v2:download": downloadEntry },
    ctx,
  );
  const refused = await lookupOrRunNode(oneVideo, "v1:download", {}, ctx).then(
    () => "resolved",
    (e: unknown) => errorMessage(e),
  );
  const downloaded = results.find((r) => r.name === "v2:download");
  assert.ok(downloaded, "v2:download's result");
  const outcome = (r: NodeResult) =>
    r.status === "succeeded" ? (r.details.actionRan ? "ran" : "hit") : r.status;
  expect({
    viaOneVideo: [
      outcome(viaOneVideo),
      resultActionKey(viaOneVideo) === resultActionKey(downloaded),
    ],
    failedDep,
    settledMissing: outcome(settledMissing),
    refused,
  }).toEqual({
    viaOneVideo: ["hit", true],
    failedDep: { name: "v2:captions", status: "dep-failed", dep: "v2:download" },
    settledMissing: "ran",
    refused:
      'the graph holds no node "v1:download". Pass a graph that holds it: the whole graph, a closure of it, or any graph that declares the node the same way. A key is local to its node, so each gives it the same key.',
  });
});

/** Checked by the typechecker alone, never run: each line after a `@ts-expect-error` must not compile. */
export function contextsThatDoNotFitDoNotCompile(g: Graph<Ports>, fs: MemoryFileSystem) {
  // @ts-expect-error ports that do not satisfy the graph's
  void lookupOrRunNode(g, "n", {}, { fs, clock, startTimer, cacheDir: "/cache" });
}
