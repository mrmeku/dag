import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";

import { forcedCache, MemCache } from "./cache.ts";
import { actionsFor } from "./define-action.ts";
import { execute } from "./execute.ts";
import { dep, Graph, nodeInputs, type ActionContext } from "./graph/index.ts";
import { createMemoryDagFs, type MemoryDagFs } from "./ports/memory-fs.ts";
import { lookupNode } from "./process-node.ts";
import { isSucceeded, type Result } from "./types.ts";

interface Ports {
  fs: MemoryDagFs;
  ran: string[];
  source: { id: string; bitrate: number };
}

async function emit(c: ActionContext<Ports>, kind: string, content: string) {
  c.ports.ran.push(kind);
  const path = `${c.outputDir}/${kind}.txt`;
  await c.ports.fs.writeText(path, content);
  return { content: path };
}
/** The video id a source file holds. */
const idOf = (text: string): string => {
  const source: unknown = JSON.parse(text);
  assert.ok(
    typeof source === "object" &&
      source !== null &&
      "id" in source &&
      typeof source.id === "string",
    "a source file holds its video's id",
  );
  return source.id;
};

const defineActionWithPorts = actionsFor<Ports>();
const source = defineActionWithPorts({
  kind: "source",
  nodeInputs: nodeInputs<{ video: string }>,
  action: async (c) => emit(c, "source", JSON.stringify(c.ports.source)),
});
const transcript = (version: number) =>
  defineActionWithPorts({
    kind: "transcript",
    deps: { source },
    inputs: { version },
    action: async (c) =>
      emit(c, "transcript", `words(${idOf(await c.depOutputs.source.content.text())})`),
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

function setup() {
  const ports: Ports = { fs: createMemoryDagFs(), ran: [], source: { id: "abc", bitrate: 128 } };
  return { ports, ctx: { ports, cache: new MemCache(), fs: ports.fs, casBaseDir: "/cas" } };
}

/** How each node of `graph` looks up against the entries of `results`, none of them run. */
async function lookups(
  graph: Graph<Ports>,
  ctx: ReturnType<typeof setup>["ctx"],
  results: Result[],
) {
  const entries = Object.fromEntries(
    results.flatMap((r) =>
      isSucceeded(r)
        ? [
            [
              r.name,
              { outputs: r.outputs, contentHash: r.contentHash, outputHashes: r.outputHashes },
            ],
          ]
        : [],
    ),
  );
  const looked = graph.describe().map(async ({ name }) => {
    const found = await lookupNode(graph, name, entries, ctx);
    return [name, found.status] as const;
  });
  return Object.fromEntries(await Promise.all(looked));
}

const statuses = (results: Result[]) => Object.fromEntries(results.map((r) => [r.name, r.status]));

describe("cache control", () => {
  test("a node whose key misses runs again, and so does each dependent; one that writes the same bytes keeps its content hash", async () => {
    const { ports, ctx } = setup();
    const first = await execute(buildGraph(), ctx);
    const sourceKey = new Set(first.filter((r) => r.name === "source").map((r) => r.actionKey));

    // A re-download at a higher bitrate: same speech, different bytes.
    ports.ran = [];
    ports.source = { id: "abc", bitrate: 320 };
    const healed = await execute(buildGraph(), {
      ...ctx,
      cache: forcedCache(ctx.cache, sourceKey),
    });
    const healRan = [...ports.ran].sort();

    ports.ran = [];
    const synced = await execute(buildGraph(), ctx);
    const syncRan = [...ports.ran];

    // A different video behind the same node: the transcript writes other words.
    ports.ran = [];
    ports.source = { id: "xyz", bitrate: 320 };
    await execute(buildGraph(), { ...ctx, cache: forcedCache(ctx.cache) });

    const transcriptHash = (results: Result[]) =>
      results.flatMap((r) => (r.name === "transcript" && isSucceeded(r) ? [r.contentHash] : []));
    expect({
      healRan,
      healStatuses: statuses(healed),
      sameWords: transcriptHash(healed).join() === transcriptHash(first).join(),
      syncRan,
      syncStatuses: statuses(synced),
      changedRan: [...ports.ran].sort(),
    }).toEqual({
      healRan: ["entry", "packaged", "source", "transcript", "uploaded"],
      healStatuses: {
        source: "done",
        transcript: "done",
        packaged: "done",
        entry: "done",
        uploaded: "done",
      },
      sameWords: true,
      syncRan: ["uploaded"],
      syncStatuses: {
        source: "cached",
        transcript: "cached",
        packaged: "cached",
        entry: "cached",
        uploaded: "done",
      },
      changedRan: ["entry", "packaged", "source", "transcript", "uploaded"],
    });
  });

  test("lookupNode looks a node up without running it: a node without a verified entry is a miss, a cacheable: false one too", async () => {
    const { ports, ctx } = setup();
    const first = await execute(buildGraph(), ctx);

    ports.ran = [];
    expect({
      changed: await lookups(buildGraph(2), ctx, first),
      unchanged: await lookups(buildGraph(), ctx, first),
      ran: ports.ran,
    }).toEqual({
      changed: {
        source: "cached",
        transcript: "missed",
        packaged: "cached",
        entry: "cached",
        uploaded: "missed",
      },
      unchanged: {
        source: "cached",
        transcript: "cached",
        packaged: "cached",
        entry: "cached",
        uploaded: "missed",
      },
      ran: [],
    });
  });
});
