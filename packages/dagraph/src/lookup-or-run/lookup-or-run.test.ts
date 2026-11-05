import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { CacheEntry, FileSystem } from "../cache/index.ts";
import { createMemoryFileSystem, type MemoryFileSystem } from "../filesystem/index.ts";
import {
  actionsFor,
  dep,
  file,
  Graph,
  isFileHandle,
  maybe,
  namedOutput,
  nodeInputs,
  pick,
  settled,
  type ActionContext,
  type DepRecord,
  type DepSpecs,
  type FileHandle,
  type FileInput,
  type NodeInputs,
  type NodeRef,
  type OutputRef,
} from "../graph/index.ts";
import {
  countResultsByStatus,
  errorMessage,
  orchestrate,
  type OrchestrationEvent,
  type ScheduledNode,
  type Scheduler,
  type SchedulerContext,
} from "../orchestration/index.ts";
import {
  fileHandle,
  isNodeResult,
  lookupNode,
  lookupOrRunNode,
  resultActionKey,
  runNode,
  type ActionEvent,
  type CancelledNodeDetails,
  type ExecutionContext,
  type FailedNodeDetails,
  type NodeResult,
  type RunActionOptions,
  type SucceededNodeDetails,
} from "./index.ts";

interface Ports {
  fs: MemoryFileSystem;
  ran: string[];
}

const defineActionWithPorts = actionsFor<Ports, "heavy">();
/** Deps in any role, as an action declares a record that its nodes name. */
const anyRole: DepSpecs = {};

/** The outputs of an action that writes one file. */
type OneFile = { out: string };

async function write(c: { outputDir: string; ports: Ports }, name: string, content: string) {
  const path = `${c.outputDir}/${name}`;
  await c.ports.fs.writeText(path, content);
  return path;
}

async function emit(c: ActionContext<Ports>, kind: string, content: string) {
  c.ports.ran.push(kind);
  return { content: await write(c, `${kind}.txt`, content) };
}

interface TaskOptions<D> {
  deps?: D;
  /** Its own inputs beside `id`: a record, or a function of its deps' refs. */
  inputs?: NodeInputs<Record<never, never>, Record<never, never>, D>;
  /** What the node writes, or throws; by default its resolved inputs as JSON. */
  run?: (c: ActionContext<Ports>) => Promise<string | undefined> | string | undefined;
  cacheable?: boolean;
  concurrencyGroup?: "heavy";
  timeoutMs?: number;
}

/** A node that writes one file. Its name is also an input, `id`, so no two nodes share a key. */
function task<Meta, D extends DepRecord = Record<never, never>>(
  g: Graph<Ports, Meta>,
  name: string,
  opts: TaskOptions<D> = {},
): NodeRef<OneFile> {
  const { deps, inputs, run, ...howToRun } = opts;
  return defineActionWithPorts({
    kind: "task",
    deps: anyRole,
    ...howToRun,
    action: async (c) => ({
      out: await write(c, "out", (await run?.(c)) ?? JSON.stringify(c.inputs)),
    }),
  }).addNode(g, {
    name,
    ...(deps && { deps }),
    inputs: (refs) => ({ id: name, ...(typeof inputs === "function" ? inputs(refs) : inputs) }),
  });
}

const clock = { epochMilliseconds: () => 0 };
const startTimer = () => () => {};

/**
 * A context on the memory filesystem and a fixed clock, whose node timeouts fire only by hand:
 * `fireTimeouts` fires each started and not yet stopped, as though each ran out.
 */
function setup() {
  const ports: Ports = { fs: createMemoryFileSystem(), ran: [] };
  const timers: (() => void)[] = [];
  const ctx: ExecutionContext<Ports> = {
    ports,
    fs: ports.fs,
    cacheDir: "/cache",
    clock,
    startTimer: (_ms, onTimeout) => {
      timers.push(onTimeout);
      return () => void timers.splice(timers.indexOf(onTimeout), 1);
    },
  };
  const fireTimeouts = () => {
    for (const fire of timers.splice(0)) fire();
  };
  return { ports, fs: ports.fs, ctx, fireTimeouts };
}

/** Each node of `graph` looked up or run in turn, given the entries of its deps that succeeded. */
async function runInTurn<Meta>(
  graph: Graph<Ports, Meta>,
  ctx: ExecutionContext<Ports>,
  options: RunActionOptions<Meta> = {},
) {
  const entries: Record<string, CacheEntry> = {};
  const results: NodeResult[] = [];
  for (const { name } of graph.describe()) {
    const result = await lookupOrRunNode(graph, name, entries, ctx, options);
    if (result.status === "succeeded") entries[name] = result.details.entry;
    results.push(result);
  }
  return { entries, results };
}

/** The scheduler double for a test that runs a whole graph: it admits every ready node at once. */
const admitAll: Scheduler = async <NodeData extends ScheduledNode>(
  ctx: SchedulerContext<NodeData>,
) => {
  while (ctx.hasWork()) {
    for (let next = ctx.take(); next; next = ctx.take()) void ctx.run(next);
    await ctx.workAvailable();
  }
};

type GraphEvent<Meta> =
  | OrchestrationEvent<Meta, SucceededNodeDetails, FailedNodeDetails, CancelledNodeDetails>
  | ActionEvent<Meta>;

/** `graph` run in one process as `execute` runs it, `runNode` in orchestration's port, over `admitAll`. */
function runGraph<Meta>(
  graph: Graph<Ports, Meta>,
  ctx: ExecutionContext<Ports>,
  {
    onEvent,
    signal,
  }: { onEvent?: (event: GraphEvent<Meta>) => void | Promise<void>; signal?: AbortSignal } = {},
) {
  const run = runNode(graph, ctx, { ...(signal && { signal }), ...(onEvent && { onEvent }) });
  return orchestrate(graph.describe(), run, admitAll, ctx.clock, onEvent, signal);
}

const matching = (re: RegExp): unknown => expect.stringMatching(re);
const anyHash = matching(/^[0-9a-f]{64}$/);
const anyNumber: unknown = expect.any(Number);

/** How a node settled: its status, or whether its action ran when it succeeded. */
const outcome = (r: NodeResult) =>
  r.status === "succeeded" ? (r.details.actionRan ? "ran" : "hit") : r.status;
const statuses = (rs: NodeResult[]) => Object.fromEntries(rs.map((r) => [r.name, outcome(r)]));
const outputsOf = (r: NodeResult | undefined) =>
  r?.status === "succeeded" ? namedOutput(r.details.entry.outputs, "out") : "";
/** The details of a result that succeeded; refused when it did not. */
const successDetailsOf = (r: NodeResult | undefined) => {
  assert.ok(r?.status === "succeeded", `${r?.name ?? "the node"} did not succeed`);
  return r.details;
};
const isAt = (fs: FileSystem, path: string) =>
  fs.lstat(path).then(
    () => true,
    () => false,
  );

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

describe("lookups", () => {
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

  test("a file input is hashed as its lookup runs: a node keys a declared file as its dep wrote it, though a node before the dep hashed it", async () => {
    const { ctx, fs } = setup();
    const reader = defineActionWithPorts({
      kind: "reader",
      deps: anyRole,
      nodeInputs: nodeInputs<{ id: string; src: FileInput }>,
      action: async (c) => ({ out: await write(c, "out", await c.inputs.src.text()) }),
    });
    const run = async (generated: string) => {
      await fs.writeText("/src/gen.ts", "old");
      const g = new Graph<Ports>();
      const src = file("/src/gen.ts");
      reader.addNode(g, { name: "early", inputs: { id: "early", src } });
      const gen = task(g, "gen", {
        cacheable: false,
        run: async (c) => (await c.ports.fs.writeText("/src/gen.ts", generated), "written"),
      });
      reader.addNode(g, { name: "late", deps: { gen }, inputs: { id: "late", src } });
      const late = (await runInTurn(g, ctx)).results.find((r) => r.name === "late");
      return [late && outcome(late), await fs.readText(outputsOf(late))];
    };
    expect([await run("one"), await run("two")]).toEqual([
      ["ran", "one"],
      ["ran", "two"],
    ]);
  });

  test("an input file that cannot be read fails the node before it gets a key", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    const unreadable = task(g, "unreadable", { inputs: { src: file("/missing.ts") } });
    task(g, "after", { deps: { unreadable } });
    const { results } = await runInTurn(g, ctx);
    expect(
      Object.fromEntries(
        results.map((r) => [
          r.name,
          r.status === "failed" ? [r.status, r.details, r.error.message] : r.status,
        ]),
      ),
    ).toEqual({
      unreadable: ["failed", undefined, "ENOENT: /missing.ts"],
      after: "dep-failed",
    });
  });

  test("a cacheable: false node runs every time and never stores an entry", async () => {
    const { ctx, fs } = setup();
    const g = new Graph<Ports>();
    task(g, "probe", { cacheable: false, run: () => "same-every-time" });
    const first = await runInTurn(g, ctx);
    const second = await runInTurn(g, ctx);
    const probe = successDetailsOf(second.results[0]);
    expect({
      runs: [statuses(first.results), statuses(second.results)],
      stored: await isAt(fs, `/cache/v1/${probe.actionKey}/manifest.json`),
    }).toEqual({ runs: [{ probe: "ran" }, { probe: "ran" }], stored: false });
  });

  test("runNode waits for the scheduler only on a miss: a hit never asks, and a miss whose wait rejects settles cancelled with its key and never runs", async () => {
    const { ctx } = setup();
    const ran: string[] = [];
    const g = new Graph<Ports>();
    for (const name of ["warm", "waiter"])
      task(g, name, { concurrencyGroup: "heavy", run: () => (ran.push(name), name) });
    await lookupOrRunNode(g, "warm", {}, ctx);
    ran.length = 0;
    const [warm, waiter] = g.describe();
    assert.ok(warm && waiter, "both nodes");
    const run = runNode(g, ctx);
    const refused = () => Promise.reject(new Error("the execution was cancelled"));
    const hit = await run(warm, {}, refused);
    const cancelled = await run(waiter, {}, refused);
    expect({ ran, hit: outcome(hit), cancelled }).toEqual<unknown>({
      ran: [],
      hit: "hit",
      cancelled: { name: "waiter", status: "cancelled", details: { actionKey: anyHash } },
    });
  });
});

describe("what an action reads", () => {
  test("a value input reads as written, its undefined properties dropped", async () => {
    const { ctx, fs } = setup();
    const g = new Graph<Ports>();
    task(g, "n", { inputs: { opts: { b: [1, 2], a: 1, c: undefined }, gone: undefined } });
    const [r] = (await runInTurn(g, ctx)).results;
    expect(await fs.readText(outputsOf(r))).toBe('{"id":"n","opts":{"b":[1,2],"a":1}}');
  });

  test("a file input reads as a handle on the file, and each node that declares it hashes it as it is looked up", async () => {
    const { ctx, fs } = setup();
    const hashed: string[] = [];
    const counting = {
      ...ctx,
      fs: { ...fs, hashFile: (p: string) => (hashed.push(p), fs.hashFile(p)) },
    };
    const reader = defineActionWithPorts({
      kind: "reader",
      nodeInputs: nodeInputs<{ id: string; src: FileInput }>,
      action: async (c) => ({
        out: await write(c, "out", `${c.inputs.src.path}: ${await c.inputs.src.text()}`),
      }),
    });
    const run = async () => {
      const g = new Graph<Ports>();
      for (const name of ["one", "two", "three"])
        reader.addNode(g, { name, inputs: { id: name, src: file("/src/a.ts") } });
      const { results } = await runInTurn(g, counting);
      return fs.readText(outputsOf(results[0]));
    };
    await fs.writeText("/src/a.ts", "a1");
    const first = await run();
    const firstHashed = hashed.filter((p) => p === "/src/a.ts").length;
    await fs.writeText("/src/a.ts", "a2");
    expect({ first, firstHashed, edited: await run() }).toEqual({
      first: "/src/a.ts: a1",
      firstHashed: 3,
      edited: "/src/a.ts: a2",
    });
  });

  test("an output ref reads as a handle on the dep's committed file", async () => {
    const { ctx, fs } = setup();
    const pack = defineActionWithPorts({
      kind: "pack",
      action: async (c) => ({ tarball: await write(c, "pkg.tgz", "pkg") }),
    });
    const publish = defineActionWithPorts({
      kind: "publish",
      deps: { pack },
      nodeInputs: nodeInputs<{ cmd: (string | OutputRef<string>)[] }>,
      action: async (c) => {
        const argv = c.inputs.cmd.map((arg) => (typeof arg === "string" ? arg : arg.path));
        return { out: await write(c, "cmd.json", JSON.stringify(argv)) };
      },
    });
    const g = new Graph<Ports>();
    const p = pack.addNode(g, {});
    publish.addNode(g, {
      deps: { pack: p },
      inputs: ({ pack }) => ({ cmd: ["npm", "publish", pack.tarball] }),
    });
    const [packed, published] = (await runInTurn(g, ctx)).results;
    const tarball = namedOutput(successDetailsOf(packed).entry.outputs, "tarball");
    expect(await fs.readText(outputsOf(published))).toBe(
      JSON.stringify(["npm", "publish", tarball]),
    );
  });

  test("a role that picks some of its dep's outputs reads only those, settled or maybe", async () => {
    const { ctx } = setup();
    const pair = defineActionWithPorts({
      kind: "pair-of-files",
      action: async (c) => ({
        main: await write(c, "main.txt", "main"),
        extra: await write(c, "extra.txt", "extra"),
      }),
    });
    const read: string[][] = [];
    const readerOf =
      (kind: string) => async (c: ActionContext<Ports>, pair: object | undefined) => {
        read.push([kind, ...Object.keys(pair ?? {})]);
        return { out: await write(c, "out.txt", kind) };
      };
    const required = defineActionWithPorts({
      kind: "required",
      deps: { pair: pick(pair, "main") },
      action: (c) => readerOf("required")(c, c.depOutputs.pair),
    });
    const settledRole = defineActionWithPorts({
      kind: "settled",
      deps: { pair: settled(pick(pair, "main")) },
      action: (c) => readerOf("settled")(c, c.depOutputs.pair),
    });
    const maybeRole = defineActionWithPorts({
      kind: "maybe",
      deps: { pair: maybe(pick(pair, "main")) },
      action: (c) => readerOf("maybe")(c, c.depOutputs.pair),
    });
    const g = new Graph<Ports>();
    const p = pair.addNode(g, {});
    required.addNode(g, { deps: { pair: p } });
    settledRole.addNode(g, { deps: { pair: settled(p) } });
    maybeRole.addNode(g, { deps: { pair: p } });
    await runInTurn(g, ctx);
    expect(read).toEqual([
      ["required", "main"],
      ["settled", "main"],
      ["maybe", "main"],
    ]);
  });

  test("an action reads each dep's outputs as handles, a file for a path and a list for a list, and isFileHandle tells a handle from the others", async () => {
    const { ctx } = setup();
    type Notes = { notes: string; parts: string[] };
    const g = new Graph<Ports>();
    const record = defineActionWithPorts({
      kind: "record",
      action: async (c) => ({
        notes: await write(c, "notes", "N"),
        parts: [await write(c, "p1", "P1"), await write(c, "p2", "P2")],
      }),
    }).addNode(g, {});
    const read = async (h: FileHandle) => [h.path, await h.text()];
    defineActionWithPorts({
      kind: "reads",
      deps: { record: dep<Notes> },
      action: async ({ depOutputs: { record: d }, ...c }) => ({
        out: await write(
          c,
          "read.json",
          JSON.stringify({
            notes: await read(d.notes),
            parts: await Promise.all(d.parts.map(read)),
            isFileHandle: [d.notes, d.parts, d].map(isFileHandle),
          }),
        ),
      }),
    }).addNode(g, { deps: { record } });
    const [recorded, reads] = (await runInTurn(g, ctx)).results;
    const outputs = successDetailsOf(recorded).entry.outputs;
    const parts = outputs["parts"];
    assert.ok(Array.isArray(parts));
    expect(JSON.parse(await ctx.fs.readText(outputsOf(reads)))).toEqual({
      notes: [namedOutput(outputs, "notes"), "N"],
      parts: [
        [parts[0], "P1"],
        [parts[1], "P2"],
      ],
      isFileHandle: [true, false, false],
    });
  });

  test("json(is) gives the value its guard accepts; a file it refuses, or one that holds no JSON, throws naming the file", async () => {
    const { ctx } = setup();
    const isCount = (v: unknown): v is { count: number } =>
      typeof v === "object" && v !== null && "count" in v && typeof v.count === "number";
    const isWords = (v: unknown): v is string[] =>
      Array.isArray(v) && v.every((w) => typeof w === "string");
    const g = new Graph<Ports>();
    const data = defineActionWithPorts({
      kind: "data",
      action: async (c) => ({
        counted: await write(c, "counted.json", '{"count":3}'),
        prose: await write(c, "prose.txt", "three words here"),
      }),
    }).addNode(g, {});
    const refusal = (read: Promise<unknown>) =>
      read.then(
        () => "",
        (e: unknown) => errorMessage(e),
      );
    defineActionWithPorts({
      kind: "parses",
      deps: { data: dep<{ counted: string; prose: string }> },
      action: async (c) => {
        const { counted, prose } = c.depOutputs.data;
        return {
          out: await write(
            c,
            "parsed.json",
            JSON.stringify({
              value: await counted.json(isCount),
              refused: await refusal(counted.json(isWords)),
              notJson: await refusal(prose.json(isWords)),
            }),
          ),
        };
      },
    }).addNode(g, { deps: { data } });
    const [made, parsed] = (await runInTurn(g, ctx)).results;
    const outputs = successDetailsOf(made).entry.outputs;
    expect(JSON.parse(await ctx.fs.readText(outputsOf(parsed)))).toEqual({
      value: { count: 3 },
      refused: `${namedOutput(outputs, "counted")} holds JSON that isWords refuses`,
      notJson: `${namedOutput(outputs, "prose")} holds no JSON`,
    });
  });

  test("hash() gives the SHA256 of a file's bytes; text() refuses a file whose bytes are not UTF-8, and reads one that holds U+FFFD", async () => {
    const utf8 = (text: string) => new TextEncoder().encode(text);
    const files = {
      "/thumb.jpg": Uint8Array.of(0xff, 0xd8, 0xff, 0xe0),
      "/replaced.txt": utf8("a � in UTF-8"),
    };
    const fs = createMemoryFileSystem(files);
    const read = async ([path, bytes]: [string, Uint8Array]) => {
      const handle = fileHandle(fs, path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return [path, [(await handle.hash()) === sha256, await handle.text().catch(errorMessage)]];
    };
    expect(Object.fromEntries(await Promise.all(Object.entries(files).map(read)))).toEqual({
      "/thumb.jpg": [
        true,
        "/thumb.jpg is not UTF-8 text: decoding it lost bytes. Hash its bytes with hash().",
      ],
      "/replaced.txt": [true, "a � in UTF-8"],
    });
  });

  test("a handle is never part of a string: TypeScript refuses it in a template string or with +, and String, JSON.stringify and join throw", async () => {
    const { ctx } = setup();
    const thrown: string[] = [];
    const g = new Graph<Ports>();
    const src = task(g, "src");
    defineActionWithPorts({
      kind: "converts",
      deps: { src: dep<OneFile> },
      action: async (c) => {
        const h = c.depOutputs.src.out;
        const conversions = [
          // @ts-expect-error -- TS2731, as for a symbol
          () => `${h}`,
          // @ts-expect-error -- TS2469, as for a symbol
          () => h + "",
          () => String(h),
          () => JSON.stringify(h),
          () => [h].join(),
        ];
        for (const convert of conversions)
          try {
            convert();
          } catch (e) {
            thrown.push(errorMessage(e));
          }
        return { out: await write(c, "out", "x") };
      },
    }).addNode(g, { deps: { src } });
    const [made] = (await runInTurn(g, ctx)).results;
    const refusal = `the handle on ${outputsOf(made)} can't be part of a string. Use its .path.`;
    expect(thrown).toEqual([refusal, refusal, refusal, refusal, refusal]);
  });
});

describe("an attempt", () => {
  test("an attempt stages in the cache's tmp, and a failed one leaves nothing behind", async () => {
    const { ctx, fs } = setup();
    const seen: string[] = [];
    const g = new Graph<Ports>();
    task(g, "broken", {
      run: async (c) => {
        seen.push(c.outputDir);
        await write(c, "partial", "half");
        throw new Error("broken");
      },
    });
    const { results } = await runInTurn(g, ctx);
    expect({
      statuses: statuses(results),
      outputDir: seen.map((dir) => dir.replace(/[0-9a-f-]{36}$/, "<uuid>")),
      files: [...fs.files.keys()],
    }).toEqual({ statuses: { broken: "failed" }, outputDir: ["/cache/tmp/<uuid>"], files: [] });
  });

  test("outputs that are no record fail the node", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    // @ts-expect-error a bare path is no record of outputs: return { out: path }
    defineActionWithPorts({ kind: "bare", action: async () => "x" }).addNode(g, {});
    const [result] = (await runInTurn(g, ctx)).results;
    expect(result?.status === "failed" && result.error.message).toBe(
      'the action returned "x", not a record of outputs: return { <name>: path }',
    );
  });

  test("a listener's promise for a start holds the action back until it resolves, and one that rejects fails the node without running it", async () => {
    const { ctx } = setup();
    const ran: string[] = [];
    const g = new Graph<Ports>();
    for (const name of ["recorded", "unrecorded"])
      task(g, name, {
        run: () => {
          ran.push(name);
          return name;
        },
      });
    const recording = Promise.withResolvers<void>();
    const recorded = Promise.withResolvers<void>();
    const execution = runInTurn(g, ctx, {
      onEvent: (e) => {
        if (e.type !== "start") return undefined;
        if (e.node === "unrecorded") return Promise.reject(new Error("the journal is full"));
        recording.resolve();
        return recorded.promise;
      },
    });
    await recording.promise;
    const ranWhileRecording = [...ran];
    recorded.resolve();
    const { results } = await execution;
    expect({
      ranWhileRecording,
      ran,
      results: Object.fromEntries(
        results.map((r) => [r.name, r.status === "failed" ? r.error.message : outcome(r)]),
      ),
    }).toEqual({
      ranWhileRecording: [],
      ran: ["recorded"],
      results: { recorded: "ran", unrecorded: "the journal is full" },
    });
  });

  test("a failed or cancelled node's details carry their key once it has one, and an elapsed exactly when its action ran; a node cancelled while it runs is never cached, whatever its action returns", async () => {
    const { ctx } = setup();
    let time = 0;
    const context = { ...ctx, clock: { epochMilliseconds: () => time } };
    const caught = new AbortController();
    const held = new AbortController();
    const g = new Graph<Ports>();
    const made = task(g, "made");
    task(g, "unkeyable", { inputs: { src: file("/missing.ts") } });
    task(g, "unresolvable", { deps: { made }, inputs: ({ made }) => ({ src: made.out }) });
    task(g, "unrecorded");
    task(g, "held");
    task(g, "broke", {
      run: () => {
        time += 40;
        throw new Error("broke");
      },
    });
    // `caught` traps the cancel and returns normally, as a command that exits 0 on SIGINT does.
    task(g, "caught", {
      run: () => {
        time += 25;
        caught.abort();
        return "caught";
      },
    });
    const process = (name: string, options: RunActionOptions<undefined> = {}) =>
      lookupOrRunNode(g, name, {}, context, options);
    const results = [
      await process("unkeyable"),
      // Its dep's entry lacks the output it reads.
      await lookupOrRunNode(
        g,
        "unresolvable",
        { made: { outputs: {}, contentHash: "h", outputHashes: {} } },
        context,
      ),
      await process("unrecorded", {
        onEvent: (e) =>
          e.type === "start" ? Promise.reject(new Error("journal full")) : undefined,
      }),
      await process("held", {
        signal: held.signal,
        onEvent: (e) => {
          if (e.type === "start") held.abort();
        },
      }),
      await process("broke"),
      await process("caught", { signal: caught.signal }),
    ];
    const failed = (name: string, message: string) => ({
      name,
      status: "failed",
      error: { name: "Error", message },
    });
    const keyed = { actionKey: anyHash };
    expect({
      results,
      caughtLater: (await lookupNode(g, "caught", {}, context)).status,
    }).toStrictEqual<unknown>({
      results: [
        failed("unkeyable", "ENOENT: /missing.ts"),
        { ...failed("unresolvable", '"made" has no output "out"'), details: keyed },
        { ...failed("unrecorded", "journal full"), details: keyed },
        { name: "held", status: "cancelled", details: keyed },
        { ...failed("broke", "broke"), details: { ...keyed, elapsed: 40 } },
        { name: "caught", status: "cancelled", details: { ...keyed, elapsed: 25 } },
      ],
      caughtLater: "missed",
    });
  });

  test("a cancel that lands while the node's output directory is made holds the action back", async () => {
    const controller = new AbortController();
    const { ctx, fs } = setup();
    const slowMkdir: FileSystem = {
      ...fs,
      ensureDir: async (path) => {
        controller.abort();
        await fs.ensureDir(path);
      },
    };
    const g = new Graph<Ports>();
    let ran = false;
    task(g, "x", { run: () => ((ran = true), "x") });
    const result = await lookupOrRunNode(
      g,
      "x",
      {},
      { ...ctx, fs: slowMkdir },
      {
        signal: controller.signal,
      },
    );
    expect({ ran, status: result.status, files: [...fs.files.keys()] }).toEqual({
      ran: false,
      status: "cancelled",
      files: [],
    });
  });
});

describe("timeouts", () => {
  test("timeoutMs: the action's signal aborts with a TimeoutError, the node fails whatever it returns and is never cached, and the timeout is not in the key", async () => {
    const { ctx, fireTimeouts } = setup();
    const reasons: string[] = [];
    const build = (quickTimeoutMs: number) => {
      const g = new Graph<Ports>();
      // `hung` waits for its signal and then returns normally, as a test runner that exits 0 on SIGINT does.
      const hung = task(g, "hung", {
        timeoutMs: 20,
        run: (c) =>
          new Promise((resolve) => {
            c.signal.addEventListener("abort", () => {
              const reason: unknown = c.signal.reason;
              reasons.push(reason instanceof Error ? reason.name : String(reason));
              resolve(undefined);
            });
            fireTimeouts();
          }),
      });
      task(g, "quick", { timeoutMs: quickTimeoutMs });
      task(g, "needs", { timeoutMs: 1000, deps: { hung } });
      task(g, "report", { timeoutMs: 1000, deps: { hung: settled(hung) } });
      return g;
    };
    const summarize = ({ results }: { results: NodeResult[] }) =>
      Object.fromEntries(
        results.map((r) => [
          r.name,
          r.status === "failed" ? [r.status, r.error.name, r.error.message] : outcome(r),
        ]),
      );
    expect({
      first: summarize(await runInTurn(build(1000), ctx)),
      second: summarize(await runInTurn(build(5000), ctx)),
      reasons,
    }).toEqual({
      first: {
        hung: ["failed", "TimeoutError", "timed out after 20 ms"],
        quick: "ran",
        needs: "dep-failed",
        report: "ran",
      },
      second: {
        hung: ["failed", "TimeoutError", "timed out after 20 ms"],
        quick: "hit",
        needs: "dep-failed",
        report: "hit",
      },
      reasons: ["TimeoutError", "TimeoutError"],
    });
  });

  test("a failure keeps the thrown error's name, message and cause; the node's own timeout is a TimeoutError that keeps the cause and is timedOut, and an action's own TimeoutError is not", async () => {
    const { ctx, fireTimeouts } = setup();
    const g = new Graph<Ports>();
    for (const [name, timeoutMs] of [["bad"], ["slow", 5]] as const)
      task(g, name, {
        ...(timeoutMs && { timeoutMs }),
        run: async (c) => {
          if (timeoutMs)
            await new Promise((r) => {
              c.signal.addEventListener("abort", r);
              fireTimeouts();
            });
          throw new RangeError(`${name} exited 1`, { cause: { argv: [name], code: 1 } });
        },
      });
    // As a fetch given `AbortSignal.timeout` throws.
    task(g, "fetch", {
      run: () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    });
    const { results } = await runInTurn(g, ctx);
    const details = { actionKey: anyHash, elapsed: anyNumber };
    expect(Object.fromEntries(results.map((r) => [r.name, r]))).toStrictEqual<unknown>({
      bad: {
        name: "bad",
        status: "failed",
        error: { name: "RangeError", message: "bad exited 1", cause: { argv: ["bad"], code: 1 } },
        details,
      },
      slow: {
        name: "slow",
        status: "failed",
        error: {
          name: "TimeoutError",
          message: "timed out after 5 ms",
          cause: { argv: ["slow"], code: 1 },
        },
        details: { ...details, timedOut: true },
      },
      fetch: {
        name: "fetch",
        status: "failed",
        error: { name: "TimeoutError", message: "The operation timed out." },
        details,
      },
    });
  });

  test("a cancel that lands after the node's own timeout still decides, as on GitHub", async () => {
    const { ctx, fireTimeouts } = setup();
    const controller = new AbortController();
    const g = new Graph<Ports>();
    task(g, "late", {
      timeoutMs: 10,
      run: async (c) => {
        await new Promise((resolve) => {
          c.signal.addEventListener("abort", resolve);
          fireTimeouts();
        });
        controller.abort();
        return "late";
      },
    });
    const events: string[] = [];
    const result = await lookupOrRunNode(g, "late", {}, ctx, {
      signal: controller.signal,
      onEvent: (e) => void events.push(e.type),
    });
    expect({ status: result.status, keyed: resultActionKey(result) !== undefined, events }).toEqual(
      { status: "cancelled", keyed: true, events: ["start"] },
    );
  });
});

describe("events", () => {
  test("a miss in a concurrency group is pending between its dispatch and its start; a hit and an ungrouped miss are not", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    task(g, "warm", { concurrencyGroup: "heavy" });
    await runInTurn(g, ctx);
    task(g, "grouped", { concurrencyGroup: "heavy" });
    task(g, "plain");
    const events: [string, string][] = [];
    await runGraph(g, ctx, {
      onEvent: (e) => {
        events.push([e.node, e.type]);
      },
    });
    const of = (node: string) => events.filter(([n]) => n === node).map(([, type]) => type);
    expect({ warm: of("warm"), grouped: of("grouped"), plain: of("plain") }).toEqual({
      warm: ["dispatch", "result"],
      grouped: ["dispatch", "pending", "start", "result"],
      plain: ["dispatch", "start", "result"],
    });
  });

  test("each event is stamped occurredAt by the context's clock as it happens, and elapsed runs from just before the action to the result", async () => {
    const { ctx } = setup();
    let time = 1000;
    const g = new Graph<Ports>();
    task(g, "grouped", {
      concurrencyGroup: "heavy",
      run: (c) => {
        time = 1100;
        c.output("half");
        time = 1250;
        return "grouped";
      },
    });
    const events: GraphEvent<undefined>[] = [];
    await runGraph(
      g,
      { ...ctx, clock: { epochMilliseconds: () => time } },
      {
        onEvent: (e) => {
          events.push(e);
          time += 1;
        },
      },
    );
    expect(events).toEqual<unknown>([
      { type: "dispatch", node: "grouped", occurredAt: 1000 },
      { type: "pending", node: "grouped", occurredAt: 1001 },
      { type: "start", node: "grouped", occurredAt: 1002 },
      { type: "output", node: "grouped", chunk: "half", occurredAt: 1100 },
      {
        type: "result",
        node: "grouped",
        occurredAt: 1250,
        result: {
          name: "grouped",
          status: "succeeded",
          details: {
            actionKey: anyHash,
            entry: {
              outputs: { out: matching(/^\/cache\/v1\/[0-9a-f]{64}\/[0-9a-f]{64}\/out$/) },
              contentHash: anyHash,
              outputHashes: { out: anyHash },
            },
            actionRan: true,
            elapsed: 247,
          },
        },
      },
    ]);
  });

  test("a node's dispatch, start, output and result come in that order, each named by node with its meta; start is live while other nodes run, a hit never starts, and what prints after the result is dropped", async () => {
    const { ctx } = setup();
    const releaseSlow = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    const build = (observed: boolean) => {
      const g = new Graph<Ports, { video: string }>();
      const sg = g.subgraph("v1", { video: "v1" });
      task(sg, "warm");
      if (!observed) return g;
      task(g, "slow", { cacheable: false, run: () => releaseSlow.promise.then(() => "slow") });
      task(sg, "fast", {
        cacheable: false,
        run: (c) => {
          c.output("one\n");
          c.output("two");
          setTimeout(() => (c.output("late"), late.resolve()), 0);
          return "fast";
        },
      });
      return g;
    };
    await runInTurn(build(false), ctx);
    const events: string[][] = [];
    let slowWhenFastSettled: string[][] = [];
    await runGraph(build(true), ctx, {
      onEvent: (e) => {
        const detail = e.type === "output" ? e.chunk : e.type === "result" ? outcome(e.result) : "";
        events.push([e.type, e.node, e.meta?.video ?? "", detail]);
        if (e.type === "result" && e.node === "v1:fast") {
          slowWhenFastSettled = events.filter((ev) => ev[1] === "slow");
          releaseSlow.resolve();
        }
      },
    });
    await late.promise;
    const of = (node: string) => events.filter((e) => e[1] === node);
    expect({
      warm: of("v1:warm"),
      fast: of("v1:fast"),
      slow: of("slow"),
      slowWhenFastSettled,
    }).toEqual({
      warm: [
        ["dispatch", "v1:warm", "v1", ""],
        ["result", "v1:warm", "v1", "hit"],
      ],
      fast: [
        ["dispatch", "v1:fast", "v1", ""],
        ["start", "v1:fast", "v1", ""],
        ["output", "v1:fast", "v1", "one\n"],
        ["output", "v1:fast", "v1", "two"],
        ["result", "v1:fast", "v1", "ran"],
      ],
      slow: [
        ["dispatch", "slow", "", ""],
        ["start", "slow", "", ""],
        ["result", "slow", "", "ran"],
      ],
      slowWhenFastSettled: [
        ["dispatch", "slow", "", ""],
        ["start", "slow", "", ""],
      ],
    });
  });
});

describe("a result is plain data", () => {
  test("a result of every status survives JSON and reads back as a result", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    const failing = task(g, "failing", {
      run: () => {
        throw new Error("failing failed", { cause: { argv: ["bun", "test"], code: 1 } });
      },
    });
    task(g, "made");
    task(g, "held", { deps: { failing } });
    const results = [
      ...(await runGraph(g, ctx)),
      ...(await runGraph(g, ctx)),
      ...(await runGraph(g, ctx, { signal: AbortSignal.abort() })),
    ];
    const received: unknown = JSON.parse(JSON.stringify(results));
    expect({
      counts: countResultsByStatus(results),
      received,
      everyIsResult: Array.isArray(received) && received.every(isNodeResult),
    }).toStrictEqual({
      counts: { succeeded: 2, failed: 2, "dep-failed": 2, cancelled: 3 },
      received: results,
      everyIsResult: true,
    });
  });

  test("isNodeResult accepts a hit, a failure with no details or no elapsed, one timedOut, and a cancel with or without details, and refuses details that lack a field their status needs, whose optional field is malformed, that are timedOut without an elapsed, or a record an earlier version wrote as a hit", () => {
    const entryOfHit = { outputs: { out: "/o" }, contentHash: "h", outputHashes: {} };
    const hit = {
      name: "a",
      status: "succeeded",
      details: { actionKey: "k", entry: entryOfHit, actionRan: false },
    };
    const failed = { name: "a", status: "failed", error: { name: "Error", message: "m" } };
    const timedOut = {
      ...failed,
      error: { name: "TimeoutError", message: "m" },
      details: { actionKey: "k", elapsed: 1, timedOut: true },
    };
    const records = {
      hit,
      // Only a node whose action ran has an elapsed time.
      ranWithoutElapsed: { ...hit, details: { ...hit.details, actionRan: true } },
      entryWithoutHash: {
        ...hit,
        details: { ...hit.details, entry: { outputs: entryOfHit.outputs, outputHashes: {} } },
      },
      outputsNotPaths: {
        ...hit,
        details: { ...hit.details, entry: { ...entryOfHit, outputs: { out: 1 } } },
      },
      failedWithoutKey: failed,
      failedBeforeStart: { ...failed, details: { actionKey: "k" } },
      detailsWithoutKey: { ...failed, details: { elapsed: 1 } },
      timedOut,
      timedOutWithoutElapsed: { ...timedOut, details: { actionKey: "k", timedOut: true } },
      timedOutNotTrue: { ...timedOut, details: { actionKey: "k", elapsed: 1, timedOut: false } },
      cancelledBeforeDispatch: { name: "a", status: "cancelled" },
      cancelledWhileRunning: {
        name: "a",
        status: "cancelled",
        details: { actionKey: "k", elapsed: 1 },
      },
      cancelledElapsedNotNumber: {
        name: "a",
        status: "cancelled",
        details: { actionKey: "k", elapsed: "1" },
      },
      earlierHit: { name: "a", actionKey: "k", status: "cached", ...entryOfHit },
    };
    expect(
      Object.fromEntries(Object.entries(records).map(([k, v]) => [k, isNodeResult(v)])),
    ).toEqual({
      hit: true,
      ranWithoutElapsed: false,
      entryWithoutHash: false,
      outputsNotPaths: false,
      failedWithoutKey: true,
      failedBeforeStart: true,
      detailsWithoutKey: false,
      timedOut: true,
      timedOutWithoutElapsed: false,
      timedOutNotTrue: false,
      cancelledBeforeDispatch: true,
      cancelledWhileRunning: true,
      cancelledElapsedNotNumber: false,
      earlierHit: false,
    });
  });
});

/** Checked by the typechecker alone, never run: each line after a `@ts-expect-error` must not compile. */
export function contextsThatDoNotFitDoNotCompile(g: Graph<Ports>, fs: MemoryFileSystem) {
  // @ts-expect-error ports that do not satisfy the graph's
  void lookupOrRunNode(g, "n", {}, { fs, clock, startTimer, cacheDir: "/cache" });
}
