import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";

import { MemCache, type CacheEntry, type DagFs } from "./cache.ts";
import { defineAction } from "./define-action.ts";
import { execute } from "./execute.ts";
import {
  closure,
  file,
  Graph,
  settled,
  type BaseParams,
  type NodeRef,
  type SettledRef,
} from "./graph/index.ts";
import { createMemoryDagFs } from "./ports/memory-fs.ts";
import { processNode } from "./process-node.ts";
import { errorMessage } from "./utils.ts";

interface Ports {
  fs: DagFs;
}
type Meta = { video: string } | { channel: true };

const download = defineAction<Ports, { inputs: { videoId: string } }, { audio: string }>({
  kind: "download",
  concurrencyGroup: "ytdlp",
  timeoutMs: 60_000,
  action: async (c) => {
    const audio = `${c.outputDir}/audio.mp3`;
    await c.ports.fs.writeText(audio, `audio of ${c.inputs.videoId}`);
    return { audio };
  },
});
const captions = defineAction<Ports, { deps: { download: NodeRef<{ audio: string }> } }, string>({
  kind: "captions",
  action: async () => {
    throw new Error("no captions");
  },
});
const entry = defineAction<
  Ports,
  { deps: { download: NodeRef<{ audio: string }>; captions: SettledRef<string> } },
  string
>({
  kind: "entry",
  cacheable: false,
  action: async (c) => {
    const path = `${c.outputDir}/entry.json`;
    await c.ports.fs.writeText(path, "{}");
    return path;
  },
});
const feed = defineAction<Ports, BaseParams, string>({
  kind: "feed",
  action: async (c) => {
    const path = `${c.outputDir}/feed.xml`;
    await c.ports.fs.writeText(path, "<rss/>");
    return path;
  },
});

/** One video's nodes, added through its subgraph. */
function addVideo(g: Graph<Ports, Meta>, videoId: string) {
  const v = g.subgraph(videoId, { video: videoId });
  const dl = download.addNode(v, { inputs: { videoId } });
  const cc = captions.addNode(v, { deps: { download: dl } });
  return entry.addNode(v, { deps: { download: dl, captions: settled(cc) } });
}

function channel(videoIds: string[]) {
  const g = new Graph<Ports, Meta>();
  const entries = videoIds.map((id) => addVideo(g, id));
  feed.addNode(g, {
    meta: { channel: true },
    deps: Object.fromEntries(entries.map((e, i) => [`entry${i}`, e])),
  });
  return g;
}

function setup() {
  const fs = createMemoryDagFs();
  return { fs, ctx: { ports: { fs }, cache: new MemCache(), fs, casBaseDir: "/cas" } };
}

const refusal = (declare: () => unknown) => {
  try {
    declare();
    return "accepted";
  } catch (e) {
    return errorMessage(e);
  }
};

describe("declarations", () => {
  test("addNode refuses a wrong declaration, naming it", () => {
    const g = new Graph<Ports, Meta>();
    const dl = download.addNode(g, { inputs: { videoId: "v1" } });
    const other = download.addNode(new Graph<Ports, Meta>().subgraph("v2"), {
      inputs: { videoId: "v2" },
    });
    const versioned = defineAction<Ports, BaseParams, string>({
      kind: "versioned",
      inputs: { version: 1 },
      action: async () => "",
    });
    const value = (v: unknown) => () => versioned.addNode(g, { name: "n", inputs: { v } });
    class Prompt {}
    expect({
      field: refusal(() =>
        // @ts-expect-error: params hold no videoId
        download.addNode(g, { inputs: { videoId: "v" }, videoId: "v" }),
      ),
      // @ts-expect-error: params hold no kind
      kind: refusal(() => download.addNode(g, { inputs: { videoId: "v" }, kind: "dl" })),
      duplicate: refusal(() => download.addNode(g, { inputs: { videoId: "v3" } })),
      unknownDep: refusal(() => captions.addNode(g, { deps: { download: other } })),
      refNotADep: refusal(() =>
        versioned.addNode(g, { name: "cmd", inputs: { argv: ["play", dl.outputs.audio] } }),
      ),
      redeclared: refusal(() => versioned.addNode(g, { name: "n", inputs: { version: 2 } })),
      inherited: refusal(() =>
        versioned.addNode(g, { name: "c", inputs: { constructor: "x", toString: "y" } }),
      ),
      // @ts-expect-error: inputs are a record
      list: refusal(() => versioned.addNode(g, { name: "n", inputs: ["bun.lock"] })),
      map: refusal(value(new Map())),
      nan: refusal(value({ ratio: Number.NaN })),
      infinity: refusal(value([Infinity])),
      bigint: refusal(value(1n)),
      fn: refusal(value({ f: () => 1 })),
      instance: refusal(value({ prompt: new Prompt() })),
      date: refusal(value(new Date(0))),
      hole: refusal(value([1, undefined])),
      nestedFile: refusal(value({ lock: file("bun.lock") })),
      node: refusal(value({ dep: dl })),
    }).toEqual({
      field:
        'node "download": params hold only name, deps, inputs and meta, not videoId. What decides the output reaches the action as an input: inputs: { ... }.',
      kind: 'node "download": params hold only name, deps, inputs and meta, not kind. A kind is its action\'s: defineAction({ kind }).',
      duplicate:
        'Duplicate node name "download". Names are unique in a graph: give the node a name of its own, or add it through graph.subgraph(prefix, meta).',
      unknownDep: 'node "captions" depends on unknown node "v2:download" (deps.download)',
      refNotADep:
        'node "cmd": inputs.argv names "download".outputs.audio, but "download" is not in its deps. Naming an output does not make a dep: declare it in deps.',
      redeclared: 'node "n": inputs.version is declared by its action "versioned"',
      inherited: "accepted",
      list: 'node "n": inputs is a list; inputs are a record of named inputs, each file(path) or a JSON value',
      map: 'node "n": inputs.v is a Map',
      nan: 'node "n": inputs.v.ratio is NaN',
      infinity: 'node "n": inputs.v[0] is Infinity',
      bigint: 'node "n": inputs.v is a bigint',
      fn: 'node "n": inputs.v.f is a function',
      instance: 'node "n": inputs.v.prompt is a Prompt',
      date: 'node "n": inputs.v is a Date',
      hole: 'node "n": inputs.v[1] is undefined',
      nestedFile: 'node "n": inputs.v.lock is a file(); a file is a whole input',
      node: 'node "n": inputs.v.dep is a node; what comes from a node is a dep, declared in deps',
    });
  });

  test("defineAction refuses config, normalize, a timeoutMs setTimeout does not honor, and inputs that are not JSON", () => {
    const action = async () => "";
    const timeout = (timeoutMs: number) => () =>
      defineAction<Ports, BaseParams, string>({ kind: "t", timeoutMs, action });
    expect({
      // @ts-expect-error: an action has a kind
      noKind: refusal(() => defineAction({ action })),
      // @ts-expect-error: config is gone
      config: refusal(() => defineAction({ kind: "c", config: "v1", action })),
      // @ts-expect-error: normalize is gone
      normalize: refusal(() => defineAction({ kind: "n", normalize: () => ({}), action })),
      timeouts: [0, -1, 1.5, Number.NaN, Infinity, 2 ** 31, 1, 2 ** 31 - 1].map((t) =>
        refusal(timeout(t)).replace(/.*got /, "refused "),
      ),
      inputs: refusal(() => defineAction({ kind: "i", inputs: { limits: new Set() }, action })),
    }).toEqual({
      noKind: "defineAction: kind is required, the kind of work the action does",
      config:
        'action "c": config is gone: declare it in inputs (config: { version: 1 } becomes inputs: { version: 1 })',
      normalize:
        'action "n": normalize is gone: declare invalidateOn: { [role]: (outputs, ports) => fingerprint }',
      timeouts: [
        "refused 0",
        "refused -1",
        "refused 1.5",
        "refused NaN",
        "refused Infinity",
        "refused 2147483648",
        "accepted",
        "accepted",
      ],
      inputs: 'action "i": inputs.limits is a Set',
    });
  });
});

describe("graphs", () => {
  test("describe() gives each node as data: its full name, kind, meta, deps, settled deps and how-to-run fields, never its inputs", () => {
    const g = channel(["v1"]);
    const nested = g.subgraph("v2", { video: "v2" }).subgraph("parts");
    download.addNode(nested, { inputs: { videoId: "v2" } });
    download.addNode(nested, {
      name: "mirror",
      meta: { channel: true },
      inputs: { videoId: "v2" },
    });
    const handedOut = g.describe();
    const entry = handedOut[2];
    assert.ok(entry, "the third node");
    entry.deps.push("ghost");
    assert.ok(entry.settledDeps, "its settled deps");
    entry.settledDeps.length = 0;
    expect(g.describe()).toEqual([
      {
        name: "v1:download",
        kind: "download",
        meta: { video: "v1" },
        deps: [],
        concurrencyGroup: "ytdlp",
        timeoutMs: 60_000,
      },
      { name: "v1:captions", kind: "captions", meta: { video: "v1" }, deps: ["v1:download"] },
      {
        name: "v1:entry",
        kind: "entry",
        meta: { video: "v1" },
        deps: ["v1:download", "v1:captions"],
        settledDeps: ["v1:captions"],
        cacheable: false,
      },
      { name: "feed", kind: "feed", meta: { channel: true }, deps: ["v1:entry"] },
      {
        name: "v2:parts:download",
        kind: "download",
        meta: { video: "v2" },
        deps: [],
        concurrencyGroup: "ytdlp",
        timeoutMs: 60_000,
      },
      {
        name: "v2:parts:mirror",
        kind: "download",
        meta: { channel: true },
        deps: [],
        concurrencyGroup: "ytdlp",
        timeoutMs: 60_000,
      },
    ]);
  });

  test("closure holds the named nodes and all they depend on, settled deps included, in the order added; executing it hits the whole graph's entries", async () => {
    const { ctx } = setup();
    const whole = channel(["v1", "v2"]);
    await execute(whole, ctx);
    const part = closure(whole, ["v2:entry"]);
    const results = await execute(part, ctx);
    expect({
      names: part.describe().map((n) => n.name),
      statuses: Object.fromEntries(results.map((r) => [r.name, r.status])),
      unknown: refusal(() => closure(whole, ["v3:entry"])),
    }).toEqual({
      names: ["v2:download", "v2:captions", "v2:entry"],
      statuses: { "v2:download": "cached", "v2:captions": "failed", "v2:entry": "done" },
      unknown: 'closure: the graph holds no node "v3:entry"',
    });
  });

  test("processNode finds a node by name in any graph that declares it the same way, and refuses a name the graph does not hold", async () => {
    const { ctx } = setup();
    const results = await execute(channel(["v1", "v2"]), ctx);
    const entryOf = (name: string) => {
      const r = results.find((x) => x.name === name);
      return r?.status === "done" || r?.status === "cached"
        ? ({ outputs: r.outputs, contentHash: r.contentHash } satisfies CacheEntry)
        : undefined;
    };
    const oneVideo = new Graph<Ports, Meta>();
    addVideo(oneVideo, "v2");
    const viaOneVideo = await processNode(oneVideo, "v2:download", {}, ctx);
    const failedDep = await processNode(oneVideo, "v2:captions", {}, ctx);
    const downloadEntry = entryOf("v2:download");
    assert.ok(downloadEntry, "v2:download's entry");
    const settledMissing = await processNode(
      oneVideo,
      "v2:entry",
      { "v2:download": downloadEntry },
      ctx,
    );
    let refused = "";
    await processNode(oneVideo, "v1:download", {}, ctx).catch(
      (e: unknown) => (refused = errorMessage(e)),
    );
    const downloaded = results.find((r) => r.name === "v2:download");
    assert.ok(downloaded, "v2:download's result");
    expect({
      viaOneVideo: [viaOneVideo.status, viaOneVideo.actionKey === downloaded.actionKey],
      failedDep,
      settledMissing: settledMissing.status,
      refused,
    }).toEqual({
      viaOneVideo: ["cached", true],
      failedDep: { name: "v2:captions", actionKey: "", status: "dep-failed", dep: "v2:download" },
      settledMissing: "done",
      refused:
        'processNode: the graph holds no node "v1:download". Pass a graph that holds it: the whole graph, a closure of it, or any graph that declares the node the same way. A key is local to its node, so each gives it the same key.',
    });
  });
});

/** Checked by the typechecker alone, never run: each line is a declaration that must not compile. */
export function wrongDeclarationsDoNotCompile() {
  const g = new Graph<Ports, Meta>();
  const dl = download.addNode(g, { inputs: { videoId: "v1" } });
  const feedRef = feed.addNode(g, {});
  // @ts-expect-error a node of `download` must add its videoId input
  download.addNode(g, { name: "x" });
  // @ts-expect-error a string node where a record node is needed
  captions.addNode(g, { name: "y", deps: { download: feedRef } });
  // @ts-expect-error a required ref in a settled role
  entry.addNode(g, { name: "z", deps: { download: dl, captions: feedRef } });
  // @ts-expect-error an action needing ports on a graph that gives none
  feed.addNode(new Graph(), {});
  // @ts-expect-error ports that do not satisfy the graph's
  void execute(g, { cache: new MemCache(), fs: createMemoryDagFs(), casBaseDir: "/cas" });
}
