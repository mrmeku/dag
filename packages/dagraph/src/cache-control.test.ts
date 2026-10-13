import { describe, expect, test } from "bun:test";

import { MemCache } from "./cache.ts";
import { defineAction } from "./define-action.ts";
import { execute, NOT_CACHED } from "./execute.ts";
import { Graph, type NodeRef } from "./graph/index.ts";
import { createMemoryDagFs } from "./ports/memory-fs.ts";

interface Ctx {
  fs: ReturnType<typeof createMemoryDagFs>;
  ran: string[];
  source: { id: string; bitrate: number };
}

/** source -> {transcript, packaged} -> entry, plus an unrelated `other`. */
function buildGraph(ctx: Ctx, configs: { transcript?: string } = {}) {
  const emit = async (kind: string, outputDir: string, content: string) => {
    ctx.ran.push(kind);
    const path = `${outputDir}/${kind}.txt`;
    await ctx.fs.writeText(path, content);
    return path;
  };
  const read = (path: string) => ctx.fs.files.get(path) as string;
  type Dep = { kind: string; deps: { source: NodeRef<string> } };

  const source = defineAction<Ctx, { kind: "source" }, string>({
    config: "s1",
    action: (c) => async (_p, _i, dir) => emit("source", dir, JSON.stringify(c.source)),
  });
  const transcript = defineAction<Ctx, Dep, string>({
    config: configs.transcript ?? "t1",
    normalize: () => ({ source: (path) => JSON.parse(read(path)).id }),
    action: () => async (_p, i, dir) =>
      emit("transcript", dir, `words(${JSON.parse(read(i.source)).id})`),
  });
  const packaged = defineAction<Ctx, Dep, string>({
    config: "p1",
    action: () => async (_p, i, dir) => emit("packaged", dir, `pkg(${read(i.source)})`),
  });
  const entry = defineAction<
    Ctx,
    { kind: "entry"; deps: { transcript: NodeRef<string>; packaged: NodeRef<string> } },
    string
  >({
    config: "e1",
    action: () => async (_p, i, dir) =>
      emit("entry", dir, `${read(i.transcript)}+${read(i.packaged)}`),
  });
  const other = defineAction<Ctx, { kind: "other" }, string>({
    config: "o1",
    action: () => async (_p, _i, dir) => emit("other", dir, "other"),
  });

  const g = new Graph();
  const src = source.addNode(g, ctx, { kind: "source" });
  const t = transcript.addNode(g, ctx, { kind: "transcript", deps: { source: src } });
  const pk = packaged.addNode(g, ctx, { kind: "packaged", deps: { source: src } });
  entry.addNode(g, ctx, { kind: "entry", deps: { transcript: t, packaged: pk } });
  other.addNode(g, ctx, { kind: "other" });
  return g;
}

const statuses = (results: { name: string; status: string }[]) =>
  Object.fromEntries(results.map((r) => [r.name, r.status]));

describe("cache control", () => {
  test("force selects nodes to re-run; a normalized dep keeps its consumer cached", async () => {
    const ctx: Ctx = { fs: createMemoryDagFs(), ran: [], source: { id: "abc", bitrate: 128 } };
    const exec = { cache: new MemCache(), fs: ctx.fs, casBaseDir: "cas" };
    await execute(buildGraph(ctx), exec);

    // A re-download at a higher bitrate: same speech, different bytes.
    ctx.ran = [];
    ctx.source = { id: "abc", bitrate: 320 };
    const healed = await execute(buildGraph(ctx), exec, { force: (n) => n.kind === "source" });
    const healRan = [...ctx.ran].sort();

    ctx.ran = [];
    const synced = await execute(buildGraph(ctx), exec);
    const syncRan = [...ctx.ran];

    // A different video behind the same node: the fingerprint changes, so the transcript re-runs.
    ctx.ran = [];
    ctx.source = { id: "xyz", bitrate: 320 };
    await execute(buildGraph(ctx), exec, { force: (n) => n.kind === "source" });

    expect({
      healRan,
      healStatuses: statuses(healed),
      syncRan,
      syncStatuses: statuses(synced),
      changedRan: [...ctx.ran].sort(),
    }).toEqual({
      healRan: ["entry", "packaged", "source"],
      healStatuses: {
        source: "done",
        transcript: "cached",
        packaged: "done",
        entry: "done",
        other: "cached",
      },
      syncRan: [],
      syncStatuses: {
        source: "cached",
        transcript: "cached",
        packaged: "cached",
        entry: "cached",
        other: "cached",
      },
      changedRan: ["entry", "packaged", "source", "transcript"],
    });
  });

  test("cacheOnly reports the cache's state without running anything", async () => {
    const ctx: Ctx = { fs: createMemoryDagFs(), ran: [], source: { id: "abc", bitrate: 128 } };
    const exec = { cache: new MemCache(), fs: ctx.fs, casBaseDir: "cas" };
    await execute(buildGraph(ctx), exec);

    ctx.ran = [];
    const results = await execute(buildGraph(ctx, { transcript: "t2" }), exec, {
      cacheOnly: true,
    });

    expect({
      ran: ctx.ran,
      statuses: statuses(results),
      errors: results.flatMap((r) => (r.status === "fail" ? [[r.name, r.error.message]] : [])),
    }).toEqual({
      ran: [],
      statuses: {
        source: "cached",
        transcript: "fail",
        packaged: "cached",
        entry: "dep-failed",
        other: "cached",
      },
      errors: [["transcript", NOT_CACHED]],
    });
  });

  test("cacheOnly can exempt nodes, so checks run over cached results only", async () => {
    const ctx: Ctx = { fs: createMemoryDagFs(), ran: [], source: { id: "abc", bitrate: 128 } };
    const exec = { cache: new MemCache(), fs: ctx.fs, casBaseDir: "cas" };
    const graph = buildGraph(ctx);
    const check = defineAction<Ctx, { kind: "check"; deps: { subject: NodeRef<string> } }, string>({
      config: "c1",
      action: (c) => async (_p, i, dir) => {
        c.ran.push("check");
        const path = `${dir}/issues.json`;
        const low = (c.fs.files.get(i.subject) as string).includes("128");
        await c.fs.writeText(path, JSON.stringify(low ? ["low bitrate"] : []));
        return path;
      },
    });
    check.addNode(graph, ctx, { kind: "check", deps: { subject: { name: "packaged" } } });
    await execute(buildGraph(ctx), exec);

    ctx.ran = [];
    const results = await execute(graph, exec, { cacheOnly: (n) => n.kind !== "check" });
    const checkResult = results.find((r) => r.name === "check")!;

    expect({
      ran: ctx.ran,
      statuses: statuses(results),
      issues: "outputs" in checkResult ? ctx.fs.files.get(checkResult.outputs as string) : null,
    }).toEqual({
      ran: ["check"],
      statuses: {
        source: "cached",
        transcript: "cached",
        packaged: "cached",
        entry: "cached",
        other: "cached",
        check: "done",
      },
      issues: '["low bitrate"]',
    });
  });
});
