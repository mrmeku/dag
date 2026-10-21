import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";

import { MemCache } from "./cache.ts";
import { actionsFor } from "./define-action.ts";
import { execute, type ExecuteOptions } from "./execute.ts";
import { dep, Graph, nodeInputs, type ActionContext } from "./graph/index.ts";
import { orchestrate } from "./orchestrate.ts";
import { createMemoryDagFs, type MemoryDagFs } from "./ports/memory-fs.ts";
import { NOT_CACHED, processNode } from "./process-node.ts";
import { unboundedScheduler } from "./schedulers.ts";
import type { Result } from "./types.ts";

interface Ports {
  fs: MemoryDagFs;
  ran: string[];
  source: { id: string; bitrate: number };
}

async function emit(c: ActionContext<Ports>, kind: string, content: string) {
  c.ports.ran.push(kind);
  const path = `${c.outputDir}/${kind}.txt`;
  await c.ports.fs.writeText(path, content);
  return path;
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
    // A re-download at another bitrate is the same speech: key only on the video's id.
    invalidateOn: { source: async (source) => idOf(await source.text()) },
    action: async (c) => emit(c, "transcript", `words(${idOf(await c.depOutputs.source.text())})`),
  });
const packaged = defineActionWithPorts({
  kind: "packaged",
  deps: { source },
  action: async (c) => emit(c, "packaged", `pkg(${await c.depOutputs.source.text()})`),
});
const entry = defineActionWithPorts({
  kind: "entry",
  deps: { transcript: dep<string>, packaged },
  action: async (c) =>
    emit(
      c,
      "entry",
      `${await c.depOutputs.transcript.text()}+${await c.depOutputs.packaged.text()}`,
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

/** An executor whose choice per node goes to processNode, as podpiper's heal and serve make it. */
const executeChoosing = (
  graph: Graph<Ports>,
  ctx: ReturnType<typeof setup>["ctx"],
  choose: (name: string) => { force?: boolean; cacheOnly?: boolean },
) =>
  orchestrate(
    graph.describe(),
    (node, depEntries, acquire) =>
      processNode(graph, node.name, depEntries, ctx, { ...choose(node.name), acquire }),
    unboundedScheduler(),
  );

const statuses = (results: Result[]) => Object.fromEntries(results.map((r) => [r.name, r.status]));

describe("cache control", () => {
  test("a forced node runs again; a dependent whose invalidateOn fingerprint is unchanged stays cached", async () => {
    const { ports, ctx } = setup();
    await execute(buildGraph(), ctx);

    // A re-download at a higher bitrate: same speech, different bytes.
    ports.ran = [];
    ports.source = { id: "abc", bitrate: 320 };
    const healed = await executeChoosing(buildGraph(), ctx, (name) => ({
      force: name === "source",
    }));
    const healRan = [...ports.ran].sort();

    ports.ran = [];
    const synced = await execute(buildGraph(), ctx);
    const syncRan = [...ports.ran];

    // A different video behind the same node: the fingerprint changes, so the transcript runs.
    ports.ran = [];
    ports.source = { id: "xyz", bitrate: 320 };
    await execute(buildGraph(), ctx, { force: true });

    expect({
      healRan,
      healStatuses: statuses(healed),
      syncRan,
      syncStatuses: statuses(synced),
      changedRan: [...ports.ran].sort(),
    }).toEqual({
      healRan: ["entry", "packaged", "source", "uploaded"],
      healStatuses: {
        source: "done",
        transcript: "cached",
        packaged: "done",
        entry: "done",
        uploaded: "done",
      },
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

  test("execute refuses v0.3.0's per-node forms, naming where a choice per node lives", async () => {
    const { ports, ctx } = setup();
    const refused = (options: ExecuteOptions) =>
      execute(buildGraph(), ctx, options).then(
        () => "accepted",
        (e: Error) => e.message,
      );
    expect({
      // @ts-expect-error: force is true or false
      predicate: await refused({ force: (n: { kind: string }) => n.kind === "source" }),
      // @ts-expect-error: execute takes no cacheOnly
      cacheOnly: await refused({ cacheOnly: true }),
      ran: ports.ran,
    }).toEqual({
      predicate:
        "execute's force is true or false. A choice per node is an executor's: pass it in processNode's options.",
      cacheOnly:
        "execute takes no cacheOnly. A choice per node is an executor's: pass it in processNode's options.",
      ran: [],
    });
  });

  test("cacheOnly looks each node up without running it: a node without a verified entry fails as not cached, a cacheable: false one too", async () => {
    const { ports, ctx } = setup();
    await execute(buildGraph(), ctx);

    ports.ran = [];
    const results = await executeChoosing(buildGraph(2), ctx, () => ({ cacheOnly: true }));
    const unchanged = await executeChoosing(buildGraph(), ctx, () => ({ cacheOnly: true }));
    // With force there is no lookup, so even a cached node fails as not cached.
    const forced = await executeChoosing(buildGraph(), ctx, () => ({
      force: true,
      cacheOnly: true,
    }));
    expect({
      ran: ports.ran,
      results: results.map((r) =>
        r.status === "failed"
          ? [r.name, r.status, r.error.message]
          : [r.name, r.status, r.status === "dep-failed" ? r.dep : ""],
      ),
      unchanged: statuses(unchanged),
      forced: forced.map((r) => (r.status === "failed" ? r.error.message : r.status)),
    }).toEqual({
      ran: [],
      results: [
        ["source", "cached", ""],
        ["transcript", "failed", NOT_CACHED],
        ["packaged", "cached", ""],
        ["entry", "dep-failed", "transcript"],
        ["uploaded", "dep-failed", "entry"],
      ],
      unchanged: {
        source: "cached",
        transcript: "cached",
        packaged: "cached",
        entry: "cached",
        uploaded: "failed",
      },
      forced: [NOT_CACHED, "dep-failed", "dep-failed", "dep-failed", "dep-failed"],
    });
  });
});
