import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";

import { MemCache, type CacheEntry, type DagFs } from "./cache.ts";
import { actionsFor, defineAction, type Action } from "./define-action.ts";
import { execute } from "./execute.ts";
import {
  closure,
  dep,
  file,
  Graph,
  maybe,
  nodeInputs,
  settled,
  type DepSpecs,
  type FileInput,
  type InputValue,
  type NodeRef,
  type OutputRef,
} from "./graph/index.ts";
import { createMemoryDagFs } from "./ports/memory-fs.ts";
import { processNode } from "./process-node.ts";
import { isSucceeded } from "./types.ts";
import { errorMessage } from "./utils.ts";

interface Ports {
  fs: DagFs;
}
type Meta = { video: string } | { channel: true };

const defineActionWithPorts = actionsFor<Ports, "ytdlp">();
/** Deps in any role, as an action declares a record that its nodes name. */
const anyRole: DepSpecs = {};

const download = defineActionWithPorts({
  kind: "download",
  nodeInputs: nodeInputs<{ videoId: string }>,
  concurrencyGroup: "ytdlp",
  timeoutMs: 60_000,
  action: async (c) => {
    const audio = `${c.outputDir}/audio.mp3`;
    await c.ports.fs.writeText(audio, `audio of ${c.inputs.videoId}`);
    return { audio };
  },
});
const captions = defineActionWithPorts({
  kind: "captions",
  deps: { download },
  action: async (): Promise<{ vtt: string }> => {
    throw new Error("no captions");
  },
});
const entry = defineActionWithPorts({
  kind: "entry",
  deps: { download, captions: settled(captions) },
  cacheable: false,
  action: async (c) => {
    const entry = `${c.outputDir}/entry.json`;
    await c.ports.fs.writeText(entry, "{}");
    return { entry };
  },
});
const feed = defineActionWithPorts({
  kind: "feed",
  deps: anyRole,
  action: async (c) => {
    const feed = `${c.outputDir}/feed.xml`;
    await c.ports.fs.writeText(feed, "<rss/>");
    return { feed };
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
    const value = (v: InputValue) => () => feed.addNode(g, { name: "n", inputs: { v } });
    const versioned = defineActionWithPorts({
      kind: "versioned",
      inputs: { version: 1 },
      action: async () => ({}),
    });
    class Prompt {
      constructor(readonly text: string) {}
    }
    // Its type is a record's, so only the run-time check sees the class.
    const prompt: { readonly text: string } = new Prompt("clean");
    const optional = defineActionWithPorts({
      kind: "optional",
      deps: { dl: maybe(download), text: maybe<{ prose: string }> },
      action: async () => ({}),
    });
    // Steps in the wrong order: the first reads a ref that the second assigns.
    let later: NodeRef<{ audio: string }>;
    const steps = [
      () => captions.addNode(g, { name: "early", deps: { download: later } }),
      () => (later = dl),
    ];
    // A narrower type hides each extra field, as a variable of a wider type does.
    const hidden = (extra: Record<string, unknown>) => () => {
      const style: { readonly model: string } = { model: "small", ...extra };
      return feed.addNode(g, { name: "n", inputs: { style } });
    };
    expect({
      duplicate: refusal(() => download.addNode(g, { inputs: { videoId: "v3" } })),
      unknownDep: refusal(() => captions.addNode(g, { deps: { download: other } })),
      required: refusal(() => steps.forEach((step) => step())),
      maybeLeftOut: refusal(() => optional.addNode(g, {})),
      // Built at run time, so its type names no input: only the run-time check sees the repeat.
      redeclared: refusal(() =>
        versioned.addNode(g, { name: "n", inputs: Object.fromEntries([["version", 2]]) }),
      ),
      inherited: refusal(() =>
        versioned.addNode(g, { name: "c", inputs: { constructor: "x", toString: "y" } }),
      ),
      nan: refusal(value({ ratio: Number.NaN })),
      infinity: refusal(value([Infinity])),
      instance: refusal(value({ prompt })),
      // A dep's refs know no output names, so a list of them would be empty.
      listed: refusal(() =>
        feed.addNode(g, { name: "l", deps: { dl }, inputs: ({ dl }) => ({ dl }) }),
      ),
      spread: refusal(() =>
        feed.addNode(g, { name: "s", deps: { dl }, inputs: ({ dl }) => ({ ...dl }) }),
      ),
      function: refusal(hidden({ format: (s: string) => s.toUpperCase() })),
      symbol: refusal(hidden({ tag: Symbol("loud") })),
      bigint: refusal(hidden({ size: 10n })),
      undefinedItem: refusal(hidden({ list: [1, undefined] })),
    }).toEqual({
      duplicate:
        'Duplicate node name "download". Names are unique in a graph: give the node a name of its own, or add it through graph.subgraph(prefix, meta).',
      unknownDep:
        'node "captions": deps.download is "v2:download", which this graph does not hold. Add that node first.',
      required:
        'node "early": deps.download is undefined, but its action "captions" requires it. Add that node first and give its ref.',
      maybeLeftOut: "accepted",
      redeclared:
        'node "n": inputs.version is declared by its action "versioned". Give the node\'s input another name.',
      inherited: "accepted",
      nan: 'node "n": inputs.v.ratio is NaN, which is not JSON. Give a finite number, or null.',
      infinity:
        'node "n": inputs.v[0] is Infinity, which is not JSON. Give a finite number, or null.',
      instance:
        'node "n": inputs.v.prompt is a Prompt, which is not JSON. Give a plain object of its fields: { ...prompt }.',
      listed: 'node "l": the refs of dl cannot be listed: name each output, as dl.<output>',
      spread: 'node "s": the refs of dl cannot be listed: name each output, as dl.<output>',
      function:
        'node "n": inputs.style.format is a function, which is not JSON. Give the data it holds, as a record.',
      symbol: 'node "n": inputs.style.tag is a symbol, which is not JSON. Give a string.',
      bigint:
        'node "n": inputs.style.size is a bigint, which is not JSON. Give a string: String(n).',
      undefinedItem:
        'node "n": inputs.style.list[1] is undefined, which is not JSON in a list. Give null, or no item.',
    });
  });

  test("defineAction refuses a timeoutMs setTimeout does not honor, and NaN in its inputs", () => {
    const action = async () => ({});
    const timeout = (timeoutMs: number) => () => defineAction({ kind: "t", timeoutMs, action });
    expect({
      timeouts: [0, -1, 1.5, Number.NaN, Infinity, 2 ** 31, 1, 2 ** 31 - 1].map((t) =>
        refusal(timeout(t)).replace(/.*got /, "refused "),
      ),
      inputs: refusal(() => defineAction({ kind: "i", inputs: { ratio: Number.NaN }, action })),
    }).toEqual({
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
      inputs: 'action "i": inputs.ratio is NaN, which is not JSON. Give a finite number, or null.',
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

  test("a subgraph holds the nodes under its prefix and all they depend on; executing it runs only those", async () => {
    const whole = channel(["v1", "v10"]);
    const shared = download.addNode(whole, { name: "shared", inputs: { videoId: "shared" } });
    captions.addNode(whole.subgraph("v1"), { name: "extra", deps: { download: shared } });
    const v1 = whole.subgraph("v1");
    const results = await execute(v1, setup().ctx);
    expect({
      names: v1.describe().map((n) => n.name),
      statuses: Object.fromEntries(results.map((r) => [r.name, r.status])),
      outside: refusal(() => closure(v1, ["v10:entry"])),
    }).toEqual({
      names: ["v1:download", "v1:captions", "v1:entry", "shared", "v1:extra"],
      statuses: {
        "v1:download": "done",
        "v1:captions": "failed",
        "v1:entry": "done",
        shared: "done",
        "v1:extra": "failed",
      },
      outside: 'closure: the graph holds no node "v10:entry"',
    });
  });

  test("processNode finds a node by name in any graph that declares it the same way, and refuses a name the graph does not hold", async () => {
    const { ctx } = setup();
    const results = await execute(channel(["v1", "v2"]), ctx);
    const entryOf = (name: string) => {
      const r = results.find((x) => x.name === name);
      return r && isSucceeded(r)
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
        'the graph holds no node "v1:download". Pass a graph that holds it: the whole graph, a closure of it, or any graph that declares the node the same way. A key is local to its node, so each gives it the same key.',
    });
  });
});

describe("refs", () => {
  test("a ref, a node's ref and a file input refuse every conversion to a string while the graph is built; the engine keys and resolves them without one", async () => {
    const g = new Graph<Ports, Meta>();
    const dl = download.addNode(g, { inputs: { videoId: "v1" } });
    const conversions = (ref: unknown) => [
      refusal(() => String(ref)),
      refusal(() => JSON.stringify({ argv: [ref] })),
      refusal(() => [ref].join(" ")),
      refusal(() => `${ref}`),
    ];
    const read = defineActionWithPorts({
      kind: "read",
      deps: anyRole,
      action: async (c) => {
        const read = `${c.outputDir}/read.txt`;
        await c.ports.fs.writeText(read, "read");
        return { read };
      },
    });
    let output: string[] = [];
    let settledOutput: string[] = [];
    read.addNode(g, {
      deps: { dl },
      inputs: ({ dl }) => ((output = conversions(dl.audio)), { argv: ["play", dl.audio] }),
    });
    read.addNode(g, {
      name: "settled read",
      deps: { dl: settled(dl) },
      inputs: ({ dl }) => ((settledOutput = conversions(dl.audio)), { argv: ["play", dl.audio] }),
    });
    const results = await execute(g, setup().ctx);
    const audio =
      'dl.audio can\'t be part of a string: its path exists only once "download" has run. ' +
      "Make it its own array item or property: [..., dl.audio] or { audio: dl.audio }.";
    const node = 'node "download" can\'t be part of a string. Put it in deps: deps: { download }.';
    const settledNode =
      'node "download" can\'t be part of a string. Put it in deps: ' +
      "deps: { download: settled(download) }.";
    const lockfile =
      'file("bun.lock") can\'t be part of a string. Make it its own input: ' +
      'inputs: { "bun.lock": file("bun.lock") }.';
    expect({
      output,
      settledOutput,
      node: conversions(dl),
      settledNode: conversions(settled(dl)),
      file: conversions(file("bun.lock")),
      statuses: results.map((r) => r.status),
    }).toEqual({
      output: [audio, audio, audio, audio],
      settledOutput: [audio, audio, audio, audio],
      node: [node, node, node, node],
      settledNode: [settledNode, settledNode, settledNode, settledNode],
      file: [lockfile, lockfile, lockfile, lockfile],
      statuses: ["done", "done", "done"],
    });
  });
});

/** Checked by the typechecker alone, never run: each line after a `@ts-expect-error` must not compile. */
export function wrongDeclarationsDoNotCompile() {
  const g = new Graph<Ports, Meta>();
  const dl = download.addNode(g, { inputs: { videoId: "v1" } });
  const feedRef = feed.addNode(g, {});
  const cmd = defineActionWithPorts({
    kind: "cmd",
    deps: anyRole,
    inputs: { version: 1 },
    action: async () => ({}),
  });
  const plain = defineActionWithPorts({
    kind: "plain",
    deps: { dl: settled(download) },
    nodeInputs: nodeInputs<{ audio: OutputRef<string> }>,
    action: async () => ({}),
  });
  // Its outputs are a record, as download's are, under another name.
  const video = defineActionWithPorts({
    kind: "video",
    action: async ({ outputDir }) => ({ video: `${outputDir}/video.mp4` }),
  }).addNode(g, {});
  class Point {
    constructor(readonly x: number) {}
  }
  let kept: OutputRef<string> | undefined;
  cmd.addNode(g, { name: "keeps", deps: { dl }, inputs: ({ dl }) => ((kept = dl.audio), {}) });

  // These compile.
  // A node may leave out a role declared maybe.
  const maybeDownload = defineActionWithPorts({
    kind: "m",
    deps: { dl: maybe(download) },
    action: async () => ({}),
  });
  maybeDownload.addNode(g, { name: "left out" });
  // Deps in a variable, each a role its action declares.
  const captionsDeps = { download: dl };
  captions.addNode(g, { name: "from a variable", deps: captionsDeps });
  // An action that takes any role takes the roles a node names.
  feed.addNode(g, { name: "named", deps: { dl, feedRef } });
  // An action that needs no ports goes on a graph that gives none, and on one that gives some.
  const portless = defineAction({ kind: "portless", action: async () => ({}) });
  portless.addNode(new Graph(), {});
  portless.addNode(g, {});
  // An action goes where one that needs more ports is expected.
  const needsPorts: Action<Ports, Record<never, never>>[] = [portless];
  // A returned template string is a path, so a role it declares takes any node that returns one.
  const written = defineActionWithPorts({
    kind: "written",
    action: async ({ outputDir }) => ({ feed: `${outputDir}/out.txt` }),
  });
  defineActionWithPorts({ kind: "reads", deps: { written }, action: async () => ({}) }).addNode(g, {
    deps: { written: feedRef },
  });
  // Own inputs typed by an index signature name no input, so a node's inputs still compile.
  const config: Record<string, string> = { model: "small" };
  defineActionWithPorts({
    kind: "configured",
    nodeInputs: nodeInputs<{ videoId: string }>,
    inputs: config,
    action: async () => ({}),
  }).addNode(g, { inputs: { videoId: "v" } });
  // An input may take a name that every object has.
  cmd.addNode(g, { name: "named inputs", inputs: { constructor: "x", valueOf: 1 } });
  // A node gives the inputs its action's nodeInputs declares, in a variable or a function's return.
  const translate = defineActionWithPorts({
    kind: "translate",
    deps: { download },
    nodeInputs: nodeInputs<{
      videoId: string;
      language?: string;
      glossary?: FileInput;
      audio?: OutputRef<string>;
    }>,
    inputs: { version: "translate-v1" },
    action: async () => ({}),
  });
  const german = { videoId: "v1", language: "de" };
  translate.addNode(g, { name: "t1", deps: { download: dl }, inputs: german });
  translate.addNode(g, {
    name: "t2",
    deps: { download: dl },
    inputs: ({ download }) => ({ videoId: "v1", audio: download.audio }),
  });
  // Either of two records, each with an optional input that the other leaves out.
  const glossed = { videoId: "v1", glossary: file("glossary.txt") };
  translate.addNode(g, {
    name: "t3",
    deps: { download: dl },
    inputs: () => (Math.random() < 0.5 ? glossed : german),
  });
  // An action whose nodeInputs is an index signature takes any input.
  defineActionWithPorts({
    kind: "tagged",
    nodeInputs: nodeInputs<Record<string, string>>,
    action: async () => ({}),
  }).addNode(g, { name: "tags", inputs: { anything: "x" } });
  // A node gives the names of one member where nodeInputs is a union of records.
  defineActionWithPorts({
    kind: "source",
    nodeInputs: nodeInputs<{ from: "youtube"; videoId: string } | { from: "disk"; path: string }>,
    action: async () => ({}),
  }).addNode(g, { name: "from disk", inputs: { from: "disk", path: "a.mp3" } });
  // A marker that names only a type goes uncalled, and called it means the same.
  defineActionWithPorts({
    kind: "called",
    nodeInputs: nodeInputs<{ videoId: string }>(),
    deps: {
      chapters: dep<{ feed: string }>(),
      captions: settled<{ feed: string }>(),
      summary: maybe<{ feed: string }>(),
    },
    action: async () => ({}),
  }).addNode(g, {
    inputs: { videoId: "v" },
    deps: { chapters: feedRef, captions: settled(feedRef) },
  });

  // @ts-expect-error a Map is not JSON: Object.fromEntries(map)
  cmd.addNode(g, { inputs: { limits: new Map<string, number>() } });
  // @ts-expect-error a Set is not JSON: [...set]
  cmd.addNode(g, { inputs: { tags: new Set<string>() } });
  // @ts-expect-error a Date is not JSON: date.toISOString()
  cmd.addNode(g, { inputs: { at: new Date(0) } });
  // @ts-expect-error a bigint is not JSON
  cmd.addNode(g, { inputs: { size: 1n } });
  // @ts-expect-error a function is not JSON
  cmd.addNode(g, { inputs: { f: () => 1 } });
  // @ts-expect-error a class instance is not JSON: a record of its fields
  cmd.addNode(g, { inputs: { at: new Point(1) } });
  // @ts-expect-error undefined is no array item
  cmd.addNode(g, { inputs: { list: [1, undefined] } });
  // @ts-expect-error a file() is its own input, never part of a value
  cmd.addNode(g, { inputs: { tools: { lock: file("bun.lock") } } });
  // @ts-expect-error a node is a dep, never a value
  cmd.addNode(g, { inputs: { tools: { dep: dl } } });
  // @ts-expect-error inputs are a record, not a list
  cmd.addNode(g, { inputs: ["bun.lock"] });
  // @ts-expect-error a node input that repeats one its action declares
  cmd.addNode(g, { name: "r", inputs: { version: 2 } });
  // @ts-expect-error an extra role: captions declares download alone
  captions.addNode(g, { name: "w", deps: { download: dl, mirror: dl } });
  // @ts-expect-error an extra role: download declares no deps
  download.addNode(g, { name: "w2", inputs: { videoId: "v" }, deps: { mirror: dl } });
  // @ts-expect-error a missing dep: captions reads download
  captions.addNode(g, { name: "m" });
  // @ts-expect-error a role declared by no action and no dep()
  defineActionWithPorts({ kind: "bare", deps: { source: {} }, action: async () => ({}) });
  // @ts-expect-error a role declared by a node: an action declares a role by an action or dep()
  defineActionWithPorts({ kind: "by ref", deps: { source: dl }, action: async () => ({}) });
  // @ts-expect-error an action's own inputs are JSON too
  defineAction({ kind: "limits", inputs: { limits: new Set<string>() }, action: async () => ({}) });
  // @ts-expect-error a group its program does not name: actionsFor<Ports, "ytdlp">()
  defineActionWithPorts({ kind: "misspelt", concurrencyGroup: "ytdl", action: async () => ({}) });
  // @ts-expect-error a group where its program names none: actionsFor<Ports, "ytdlp">()
  defineAction({ kind: "ungrouped", concurrencyGroup: "ytdlp", action: async () => ({}) });
  // @ts-expect-error a ref to a dep the node does not declare: its deps hold no mirror
  cmd.addNode(g, { deps: { dl }, inputs: (_deps: { mirror: unknown }) => ({}) });
  // @ts-expect-error a ref that another node's function received
  cmd.addNode(g, { name: "reuses", deps: { dl }, inputs: () => ({ audio: kept }) });
  // @ts-expect-error a settled dep's ref may be missing, so it is never a plain OutputRef
  plain.addNode(g, { deps: { dl: settled(dl) }, inputs: ({ dl }) => ({ audio: dl.audio }) });
  // @ts-expect-error a missing node input: a node of `download` gives its videoId
  download.addNode(g, { name: "x" });
  // @ts-expect-error a node input of the wrong type: videoId is a string
  download.addNode(g, { name: "x2", inputs: { videoId: 1 } });
  // @ts-expect-error a dep from the wrong action: feed's record holds no audio
  captions.addNode(g, { name: "y", deps: { download: feedRef } });
  // @ts-expect-error a dep from the wrong action: video's record holds no audio
  captions.addNode(g, { name: "y2", deps: { download: video } });
  // @ts-expect-error a required ref in a settled role
  entry.addNode(g, { name: "z", deps: { download: dl, captions: feedRef } });
  // @ts-expect-error a settled ref in a required role
  captions.addNode(g, { name: "z2", deps: { download: settled(dl) } });
  defineActionWithPorts({
    kind: "misspelt",
    deps: { download },
    action: async ({ depOutputs }) => {
      // @ts-expect-error a misspelt output: download returns audio
      void depOutputs.download.audoi;
      return {};
    },
  });
  defineActionWithPorts({
    kind: "misspelt",
    deps: { download },
    invalidateOn: {
      download: (outputs) => {
        // @ts-expect-error a misspelt output in a fingerprint
        void outputs.audoi;
        return "";
      },
    },
    action: async () => ({}),
  });
  defineActionWithPorts({
    kind: "misspelt",
    deps: { download },
    // @ts-expect-error a fingerprint for a role the action does not declare
    invalidateOn: { mirror: () => "" },
    action: async () => ({}),
  });
  defineActionWithPorts({
    kind: "unchecked",
    deps: { captions: settled(captions) },
    // @ts-expect-error a settled dep's outputs used as present: it may have failed
    action: async ({ depOutputs }) => ({ vtt: depOutputs.captions.vtt.path }),
  });
  defineActionWithPorts({
    kind: "unchecked",
    deps: { download: maybe(download) },
    // @ts-expect-error a maybe role's outputs used as present: a node may leave it out
    action: async ({ depOutputs }) => ({ audio: depOutputs.download.audio.path }),
  });
  defineActionWithPorts({
    kind: "unchecked",
    deps: { captions: settled<{ vtt: string }> },
    // @ts-expect-error a settled role declared by its type, used as present: it may have failed
    action: async ({ depOutputs }) => ({ vtt: depOutputs.captions.vtt.path }),
  });
  defineActionWithPorts({
    kind: "unchecked",
    deps: { summary: maybe<{ prose: string }> },
    // @ts-expect-error a maybe role declared by its type, used as present: a node may leave it out
    action: async ({ depOutputs }) => ({ prose: depOutputs.summary.prose.path }),
  });
  // @ts-expect-error params hold no videoId: it is an input
  download.addNode(g, { name: "p", inputs: { videoId: "v" }, videoId: "v" });
  // @ts-expect-error params hold no kind: a kind is its action's
  download.addNode(g, { name: "k", inputs: { videoId: "v" }, kind: "dl" });
  cmd.addNode(g, {
    name: "strings",
    deps: { dl },
    inputs: ({ dl }) => ({
      // @ts-expect-error a ref in a template string (TS2731)
      flag: `--file=${dl.audio}`,
      // @ts-expect-error a ref with + (TS2469)
      plus: "--file=" + dl.audio,
    }),
  });
  // @ts-expect-error a node's ref in a template string (TS2731)
  void `${dl}`;
  // @ts-expect-error a node's ref where a string goes (TS2322)
  const named: string = dl;
  // @ts-expect-error a file input in a template string (TS2731)
  void `--config=${file("eslint.config.ts")}`;
  void named;
  // @ts-expect-error an action needing ports on a graph that gives none
  feed.addNode(new Graph(), {});
  // @ts-expect-error ports that do not satisfy the graph's
  void execute(g, { cache: new MemCache(), fs: createMemoryDagFs(), casBaseDir: "/cas" });
  // @ts-expect-error a graph typed as one that needs no ports: <P extends Ports>(graph: Graph<P>)
  const portlessGraph: Graph<unknown, Meta> = g;
  // @ts-expect-error a graph typed as one whose nodes carry other meta
  const otherMeta: Graph<Ports, Meta | { other: true }> = g;
  // @ts-expect-error an action typed as one that needs no ports: its type is typeof written
  const portlessAction: Action<unknown, { feed: string }> = written;
  // @ts-expect-error an action typed as one whose nodes give no inputs: download's give a videoId
  const noInputs: Action<Ports, { audio: string }> = download;
  void [needsPorts, portlessGraph, otherMeta, portlessAction, noInputs];
  const extraRole = { download: dl, mirror: dl };
  // @ts-expect-error an extra role in a variable, which no excess-property check sees
  captions.addNode(g, { name: "v1", deps: extraRole });
  // @ts-expect-error a misspelt maybe role: an index signature may hold any role
  maybeDownload.addNode(g, { name: "v2", deps: Object.fromEntries([["dll", dl]]) });
  const subs = defineActionWithPorts({
    kind: "subtitles",
    action: async ({ outputDir }): Promise<{ vtt: string; srt?: string }> => ({
      vtt: `${outputDir}/a.vtt`,
    }),
  }).addNode(g, {});
  // @ts-expect-error a ref to an output that a return may leave out: read it from depOutputs
  cmd.addNode(g, { name: "srt", deps: { subs }, inputs: ({ subs }) => (void subs.srt, {}) });
  const languages = defineActionWithPorts({
    kind: "languages",
    action: async ({ outputDir }) => {
      const found: Record<string, string> = { en: `${outputDir}/en.vtt` };
      return found;
    },
  }).addNode(g, {});
  cmd.addNode(g, {
    name: "fr",
    deps: { languages },
    // @ts-expect-error a ref to an output an index signature names: read it from depOutputs
    inputs: ({ languages }) => (void languages.fr, {}),
  });
  // @ts-expect-error a bare name is a list of its characters: closure(g, ["v1:entry"])
  void closure(g, "v1:entry");
  translate.addNode(g, {
    name: "x1",
    deps: { download: dl },
    // @ts-expect-error a node input its action's nodeInputs does not declare: a misspelt language
    inputs: { videoId: "v", langauge: "de" },
  });
  const misspelt = { videoId: "v", langauge: "de" };
  // @ts-expect-error a misspelt node input in a variable, which no excess-property check sees
  translate.addNode(g, { name: "x2", deps: { download: dl }, inputs: misspelt });
  translate.addNode(g, {
    name: "x3",
    deps: { download: dl },
    // @ts-expect-error a misspelt node input that its inputs function returns
    inputs: () => ({ videoId: "v", langauge: "de" }),
  });
}
