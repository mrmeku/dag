import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type FileSystem } from "./cache/index.ts";
import { execute, startGlobalTimer, wallClock, type ExecutionEvent } from "./execute.ts";
import { createBunFileSystem } from "./filesystem/bun.ts";
import { createMemoryFileSystem } from "./filesystem/index.ts";
import { createNodeFileSystem } from "./filesystem/node.ts";
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
  type Handles,
  type NodeInputs,
  type NodeRef,
  type OutputRef,
  type Outputs,
  type SettledOutputRef,
} from "./graph/index.ts";
import {
  fileHandle,
  isNodeResult,
  lookupOrRunNode,
  resultActionKey,
  runNode,
  type NodeResult,
  type RunActionOptions,
} from "./lookup-or-run/index.ts";
import { countResultsByStatus, errorMessage, orchestrate } from "./orchestration/index.ts";
import { throttledScheduler } from "./schedulers/index.ts";

interface Ports {
  fs: FileSystem;
}

type Group = "group_a" | "group_b" | "heavy";

/** Whether anything is at `path`, as `lstat` finds it. */
const isAt = (fs: FileSystem, path: string) =>
  fs.lstat(path).then(
    () => true,
    () => false,
  );

const defineActionWithPorts = actionsFor<Ports, Group>();
/** Deps in any role, as an action declares a record that its nodes name. */
const anyRole: DepSpecs = {};

/** The outputs of an action that writes one file. */
type OneFile = { out: string };

async function write(c: { outputDir: string; ports: Ports }, name: string, content: string) {
  const path = `${c.outputDir}/${name}`;
  await c.ports.fs.writeText(path, content);
  return path;
}

interface TaskOptions<D> {
  deps?: D;
  /** Its own inputs beside `id`: a record, or a function of its deps' refs. */
  inputs?: NodeInputs<Record<never, never>, Record<never, never>, D>;
  /** What the node writes, or throws; by default its resolved inputs as JSON. */
  run?: (c: ActionContext<Ports>) => Promise<string | undefined> | string | undefined;
  cacheable?: boolean;
  concurrencyGroup?: Group;
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

function setup() {
  const fs = createMemoryFileSystem();
  return {
    fs,
    ctx: { ports: { fs }, fs, cacheDir: "/cache", clock: wallClock, startTimer: startGlobalTimer },
  };
}

const matching = (re: RegExp): unknown => expect.stringMatching(re);
const anyHash = matching(/^[0-9a-f]{64}$/);
const anyNumber: unknown = expect.any(Number);

/** How a node settled: its status, or whether its action ran when it succeeded. */
const outcome = (r: NodeResult) =>
  r.status === "succeeded" ? (r.details.actionRan ? "ran" : "hit") : r.status;
const statuses = (rs: NodeResult[]) => Object.fromEntries(rs.map((r) => [r.name, outcome(r)]));
const counts = (rs: NodeResult[]) => ({
  ran: rs.filter((r) => outcome(r) === "ran").length,
  hit: rs.filter((r) => outcome(r) === "hit").length,
});
const outputsOf = (r: NodeResult | undefined) =>
  r?.status === "succeeded" ? namedOutput(r.details.entry.outputs, "out") : "";
/** The details of a result that succeeded; refused when it did not. */
const successDetailsOf = (r: NodeResult | undefined) => {
  assert.ok(r?.status === "succeeded", `${r?.name ?? "the node"} did not succeed`);
  return r.details;
};
/** The text of a dep's `out`. */
const depText = (outputs: Handles<Outputs> | undefined) => {
  const out = outputs?.["out"];
  assert.ok(isFileHandle(out), "the dep's out is one file");
  return out.text();
};

function buildItems(ids: string[]): Graph<Ports, { item: string } | undefined> {
  const g = new Graph<Ports, { item: string } | undefined>();
  const entries = ids.map((id) => {
    const sg = g.subgraph(id, { item: id });
    const t = (name: string, deps: Record<string, NodeRef> = {}) =>
      task(sg, name, { deps, inputs: { item: id } });
    const fetch = t("fetch");
    const extract = t("extract", { fetch });
    const parse = t("parse", { extract });
    const summarize = t("summarize", { parse });
    const classify = t("classify", { parse });
    const resize = t("resize", { fetch });
    return t("entry", { summarize, classify, extract, resize });
  });
  task(g, "aggregate", { deps: Object.fromEntries(entries.map((e, i) => [`entry${i}`, e])) });
  return g;
}

describe("execute", () => {
  test("incremental items", async () => {
    const { ctx } = setup();
    expect({
      first: counts(await execute(buildItems(["aaa", "bbb"]), ctx)),
      again: counts(await execute(buildItems(["aaa", "bbb"]), ctx)),
      added: counts(await execute(buildItems(["aaa", "bbb", "ccc"]), ctx)),
    }).toEqual({
      first: { ran: 15, hit: 0 },
      again: { ran: 0, hit: 15 },
      added: { ran: 8, hit: 14 },
    });
  });

  test("an input rolled back hits its earlier entry", async () => {
    const { ctx } = setup();
    const build = (version: string) => {
      const g = new Graph<Ports>();
      const fetch = task(g, "fetch");
      const parse = task(g, "parse", { deps: { fetch } });
      task(g, "summarize", { deps: { parse }, inputs: { version } });
      return g;
    };
    expect([
      counts(await execute(build("v2"), ctx)),
      counts(await execute(build("v3"), ctx)),
      counts(await execute(build("v2"), ctx)),
    ]).toEqual([
      { ran: 3, hit: 0 },
      { ran: 1, hit: 2 },
      { ran: 0, hit: 3 },
    ]);
  });

  test("forcing every key runs every node, and their writes are the next run's entries", async () => {
    const { ctx } = setup();
    const build = () => {
      const g = new Graph<Ports>();
      const a = task(g, "a");
      task(g, "b", { deps: { a } });
      return g;
    };
    expect([
      counts(await execute(build(), ctx)),
      counts(await execute(build(), { ...ctx, forcedKeys: "all" })),
      counts(await execute(build(), ctx)),
    ]).toEqual([
      { ran: 2, hit: 0 },
      { ran: 2, hit: 0 },
      { ran: 0, hit: 2 },
    ]);
  });
});

test("forcing a node's key runs it again, and each dependent whose dep's content changed; one that writes the same bytes keeps its content hash", async () => {
  const { ctx } = setup();
  let video = "abc@128";
  const ran: string[] = [];
  const build = () => {
    const g = new Graph<Ports>();
    const logged =
      (name: string, text: (c: ActionContext<Ports>) => Promise<string>) =>
      async (c: ActionContext<Ports>) => {
        ran.push(name);
        return text(c);
      };
    const source = task(g, "source", { run: logged("source", async () => video) });
    const transcript = task(g, "transcript", {
      deps: { source },
      // The words are the video's, whatever its bitrate.
      run: logged("transcript", async (c) => {
        const [id] = (await depText(c.depOutputs["source"])).split("@");
        return `words(${id})`;
      }),
    });
    const packaged = task(g, "packaged", {
      deps: { source },
      run: logged("packaged", async (c) => `pkg(${await depText(c.depOutputs["source"])})`),
    });
    const entry = task(g, "entry", {
      deps: { transcript, packaged },
      run: logged("entry", async () => "entry"),
    });
    task(g, "uploaded", {
      deps: { entry },
      cacheable: false,
      run: logged("uploaded", async () => "id"),
    });
    return g;
  };
  const transcriptHash = (results: NodeResult[]) =>
    results.flatMap((r) =>
      r.name === "transcript" && r.status === "succeeded" ? [r.details.entry.contentHash] : [],
    );
  const ranIn = async (run: () => Promise<NodeResult[]>) => {
    ran.length = 0;
    const results = await run();
    return { ran: [...ran].sort(), results };
  };
  const first = await execute(build(), ctx);
  const sourceKey = new Set(
    first.flatMap((r) =>
      r.name === "source" && r.status === "succeeded" ? [r.details.actionKey] : [],
    ),
  );
  // A re-download at a higher bitrate: the same speech, other bytes.
  video = "abc@320";
  const forced = await ranIn(() => execute(build(), { ...ctx, forcedKeys: sourceKey }));
  const synced = await ranIn(() => execute(build(), ctx));
  expect({
    forced: forced.ran,
    sameWords: transcriptHash(forced.results).join() === transcriptHash(first).join(),
    synced: synced.ran,
  }).toEqual({
    forced: ["entry", "packaged", "source", "transcript", "uploaded"],
    sameWords: true,
    synced: ["uploaded"],
  });
});

describe("what an action reads", () => {
  test("a value input reads as written, its undefined properties dropped", async () => {
    const { ctx, fs } = setup();
    const g = new Graph<Ports>();
    task(g, "n", { inputs: { opts: { b: [1, 2], a: 1, c: undefined }, gone: undefined } });
    const [r] = await execute(g, ctx);
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
      const results = await execute(g, counting);
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

  test("a node keys a declared file as its dep wrote it, though a node before the dep hashed it in the same execution", async () => {
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
      const late = (await execute(g, ctx)).find((r) => r.name === "late");
      return [late && outcome(late), await fs.readText(outputsOf(late))];
    };
    expect([await run("one"), await run("two")]).toEqual([
      ["ran", "one"],
      ["ran", "two"],
    ]);
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
    const [packed, published] = await execute(g, ctx);
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
    await execute(g, ctx);
    expect(read).toEqual([
      ["required", "main"],
      ["settled", "main"],
      ["maybe", "main"],
    ]);
  });

  test("an input file that cannot be read fails the node before it gets a key", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    const unreadable = task(g, "unreadable", { inputs: { src: file("/missing.ts") } });
    task(g, "after", { deps: { unreadable } });
    const results = await execute(g, ctx);
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
});

describe("file handles", () => {
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
    const [recorded, reads] = await execute(g, ctx);
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
    const [made, parsed] = await execute(g, ctx);
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
      "/replaced.txt": utf8("a \uFFFD in UTF-8"),
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
      "/replaced.txt": [true, "a \uFFFD in UTF-8"],
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
    const [made] = await execute(g, ctx);
    const refusal = `the handle on ${outputsOf(made)} can't be part of a string. Use its .path.`;
    expect(thrown).toEqual([refusal, refusal, refusal, refusal, refusal]);
  });
});

describe("the cache", () => {
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
    const results = await execute(g, ctx);
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
    const [result] = await execute(g, ctx);
    expect(result?.status === "failed" && result.error.message).toBe(
      'the action returned "x", not a record of outputs: return { <name>: path }',
    );
  });

  const filesystems: [string, () => FileSystem][] = [
    ["memory", createMemoryFileSystem],
    ["Bun", createBunFileSystem],
    ["Node", createNodeFileSystem],
  ];
  for (const [label, createFs] of filesystems)
    test(`${label} fs: a concurrent run that rewrites its output while another run's dependent reads it never poisons that dependent's entry`, async () => {
      const fs = createFs();
      const cacheDir = `${await mkdtemp(join(tmpdir(), "dagraph-"))}/cache`;
      const c = { ports: { fs }, fs, cacheDir, clock: wallClock, startTimer: startGlobalTimer };
      const aInDouble = Promise.withResolvers<void>();
      const bTruncated = Promise.withResolvers<void>();
      const bMayFinish = Promise.withResolvers<void>();
      const graph = (run: "A" | "B" | "C") => {
        const g = new Graph<Ports>();
        const count = task(g, "count", {
          run: async (c) => {
            if (run === "B") {
              await aInDouble.promise;
              await c.ports.fs.writeText(`${c.outputDir}/out`, "4");
              bTruncated.resolve();
              await bMayFinish.promise;
            }
            return "42";
          },
        });
        task(g, "double", {
          deps: { count },
          run: async (c) => {
            if (run === "A") {
              aInDouble.resolve();
              await bTruncated.promise;
            }
            const n = Number(await depText(c.depOutputs["count"]));
            if (run === "A") setTimeout(() => bMayFinish.resolve(), 0);
            return String(n * 2);
          },
        });
        return g;
      };

      await Promise.all([execute(graph("A"), c), execute(graph("B"), c)]);
      const third = await execute(graph("C"), c);
      const double = third.find((r) => r.name === "double");
      const read = double && outcome(double) === "hit" && (await fs.readText(outputsOf(double)));
      await rm(dirname(cacheDir), { recursive: true, force: true });
      expect({ statuses: statuses(third), double: read }).toEqual({
        statuses: { count: "hit", double: "hit" },
        double: "84",
      });
    });
});

describe("cacheable: false", () => {
  test("runs every time, never stores an entry, and downstream still caches by content", async () => {
    const { ctx, fs } = setup();
    const build = () => {
      const g = new Graph<Ports>();
      const probe = task(g, "probe", { cacheable: false, run: () => "same-every-time" });
      task(g, "report", { deps: { probe } });
      return g;
    };
    await execute(build(), ctx);
    const second = await execute(build(), ctx);
    const probe = successDetailsOf(second.find((r) => r.name === "probe"));
    expect({
      second: statuses(second),
      stored: await isAt(fs, `/cache/v1/${probe.actionKey}/manifest.json`),
    }).toEqual({ second: { probe: "ran", report: "hit" }, stored: false });
  });
});

test("early cutoff: a node that runs again to the same content keeps its dependents cached, one with new content does not", async () => {
  const { ctx } = setup();
  const build = (version: number, content: string) => {
    const g = new Graph<Ports>();
    const a = task(g, "a", { inputs: { version }, run: () => content });
    const b = task(g, "b", { deps: { a } });
    task(g, "c", { deps: { b } });
    return g;
  };
  expect([
    statuses(await execute(build(1, "stable"), ctx)),
    statuses(await execute(build(2, "stable"), ctx)),
    statuses(await execute(build(3, "changed"), ctx)),
  ]).toEqual([
    { a: "ran", b: "ran", c: "ran" },
    { a: "ran", b: "hit", c: "hit" },
    { a: "ran", b: "ran", c: "hit" },
  ]);
});

describe("events", () => {
  test("a miss in a concurrency group is pending between its dispatch and its start; a hit and an ungrouped miss are not", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    task(g, "warm", { concurrencyGroup: "heavy" });
    await execute(g, ctx);
    task(g, "grouped", { concurrencyGroup: "heavy" });
    task(g, "plain");
    const events: [string, string][] = [];
    await execute(g, ctx, {
      scheduler: throttledScheduler({ concurrencyLimits: { heavy: 1 } }),
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
    const events: ExecutionEvent[] = [];
    await execute(
      g,
      { ...ctx, clock: { epochMilliseconds: () => time } },
      {
        scheduler: throttledScheduler({ concurrencyLimits: { heavy: 1 } }),
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
    await execute(build(false), ctx);
    const events: string[][] = [];
    let slowWhenFastSettled: string[][] = [];
    await execute(build(true), ctx, {
      onEvent: (e: ExecutionEvent<{ video: string }>) => {
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

  test("a failure keeps the thrown error's name, message and cause; the node's own timeout is a TimeoutError that keeps the cause and is timedOut, and an action's own TimeoutError is not", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    for (const [name, timeoutMs] of [["bad"], ["slow", 5]] as const)
      task(g, name, {
        ...(timeoutMs && { timeoutMs }),
        run: async (c) => {
          if (timeoutMs) await new Promise((r) => c.signal.addEventListener("abort", r));
          throw new RangeError(`${name} exited 1`, { cause: { argv: [name], code: 1 } });
        },
      });
    // As a fetch given `AbortSignal.timeout` throws.
    task(g, "fetch", {
      run: () => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    });
    const results = await execute(g, ctx);
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
      ...(await execute(g, ctx)),
      ...(await execute(g, ctx)),
      ...(await execute(g, ctx, { signal: AbortSignal.abort() })),
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
    const entry = { outputs: { out: "/o" }, contentHash: "h", outputHashes: {} };
    const hit = {
      name: "a",
      status: "succeeded",
      details: { actionKey: "k", entry, actionRan: false },
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
        details: { ...hit.details, entry: { outputs: entry.outputs, outputHashes: {} } },
      },
      outputsNotPaths: {
        ...hit,
        details: { ...hit.details, entry: { ...entry, outputs: { out: 1 } } },
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
      earlierHit: { name: "a", actionKey: "k", status: "cached", ...entry },
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
  const execution = execute(g, ctx, {
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
  const results = await execution;
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

test("a failed or cancelled node's details carry their key once it has one, and an elapsed exactly when its action ran", async () => {
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
      onEvent: (e) => (e.type === "start" ? Promise.reject(new Error("journal full")) : undefined),
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
  expect(results).toStrictEqual<unknown>([
    failed("unkeyable", "ENOENT: /missing.ts"),
    { ...failed("unresolvable", '"made" has no output "out"'), details: keyed },
    { ...failed("unrecorded", "journal full"), details: keyed },
    { name: "held", status: "cancelled", details: keyed },
    { ...failed("broke", "broke"), details: { ...keyed, elapsed: 40 } },
    { name: "caught", status: "cancelled", details: { ...keyed, elapsed: 25 } },
  ]);
});

test("an interrupted execution resumes from where it left off", async () => {
  const { ctx } = setup();
  let bFails = true;
  const build = () => {
    const g = new Graph<Ports>();
    const a = task(g, "a");
    const b = task(g, "b", {
      deps: { a },
      run: () => {
        if (bFails) throw new Error("transient failure");
        return "b";
      },
    });
    const c = task(g, "c", { deps: { b } });
    task(g, "d", { deps: { c } });
    return g;
  };
  const first = statuses(await execute(build(), ctx));
  bFails = false;
  const started: string[] = [];
  const second = statuses(
    await execute(build(), ctx, {
      onEvent: (e) => {
        if (e.type === "start") started.push(e.node);
      },
    }),
  );
  expect({ first, second, started }).toEqual({
    first: { a: "ran", b: "failed", c: "dep-failed", d: "dep-failed" },
    second: { a: "hit", b: "ran", c: "ran", d: "ran" },
    started: ["b", "c", "d"],
  });
});

test("a settled dep: its dependent runs without it, keyed as missing, and runs again once it succeeds", async () => {
  const { ctx } = setup();
  let ready = false;
  const received: unknown[] = [];
  const captions = defineActionWithPorts({
    kind: "captions",
    action: async (c) => {
      if (!ready) throw new Error("not ready");
      return { srt: await write(c, "captions.srt", "hello") };
    },
  });
  const entry = defineActionWithPorts({
    kind: "entry",
    deps: { captions: settled(captions) },
    nodeInputs: nodeInputs<{ srt: SettledOutputRef<string> }>,
    action: async (c) => {
      received.push([
        c.depOutputs.captions === undefined,
        c.inputs.srt?.path === c.depOutputs.captions?.srt.path,
      ]);
      return { out: await write(c, "entry.txt", "entry") };
    },
  });
  const run = async () => {
    const g = new Graph<Ports>();
    const ref = captions.addNode(g, {});
    entry.addNode(g, {
      deps: { captions: settled(ref) },
      inputs: ({ captions }) => ({ srt: captions.srt }),
    });
    return statuses(await execute(g, ctx));
  };
  expect({
    runs: [await run(), await run(), ((ready = true), await run()), await run()],
    received,
  }).toEqual({
    runs: [
      { captions: "failed", entry: "ran" },
      { captions: "failed", entry: "hit" },
      { captions: "ran", entry: "ran" },
      { captions: "hit", entry: "hit" },
    ],
    received: [
      [true, true],
      [false, true],
    ],
  });
});

test("a node two roles name is one dep: the dependent runs once with it in both roles, and stays required when one role is settled", async () => {
  const { ctx } = setup();
  let broken = false;
  const runs: unknown[] = [];
  const both = defineActionWithPorts({
    kind: "both",
    deps: { main: dep<OneFile>, after: settled<OneFile> },
    action: async (c) => {
      runs.push(c.depOutputs.main.out.path === c.depOutputs.after?.out.path);
      return { out: await write(c, "both.txt", "both") };
    },
  });
  const run = async () => {
    const g = new Graph<Ports>();
    const ref = task(g, "src", {
      run: () => {
        if (broken) throw new Error("src broke");
        return "src";
      },
    });
    both.addNode(g, { deps: { main: ref, after: settled(ref) } });
    return {
      described: g.describe().find((n) => n.name === "both")?.deps,
      statuses: statuses(await execute(g, { ...ctx, forcedKeys: "all" })),
    };
  };
  const ok = await run();
  broken = true;
  expect({ ok, srcBroken: await run(), runs }).toEqual({
    ok: { described: ["src"], statuses: { src: "ran", both: "ran" } },
    srcBroken: { described: ["src"], statuses: { src: "failed", both: "dep-failed" } },
    runs: [true],
  });
});

describe("cancellation and timeouts", () => {
  test("cancel: a running node is cancelled whatever its action returns, and never cached; no action starts after the cancel", async () => {
    const { ctx } = setup();
    const seen: string[] = [];
    // `slow` traps the cancel and returns normally, as a command that exits 0 on SIGINT does.
    let cancelling = true;
    const g = new Graph<Ports>();
    const slow = task(g, "slow", {
      run: async (c) => {
        seen.push("slow");
        if (cancelling) await new Promise((r) => c.signal.addEventListener("abort", r));
        return undefined;
      },
    });
    const quick = task(g, "quick", { run: () => (seen.push("quick"), undefined) });
    task(g, "after", { deps: { quick }, run: () => (seen.push("after"), undefined) });
    task(g, "never", { deps: { slow }, run: () => (seen.push("never"), undefined) });
    const controller = new AbortController();
    const results = await execute(g, ctx, {
      scheduler: throttledScheduler({ maxParallelism: 2 }),
      signal: controller.signal,
      onEvent: (e) => {
        // quick settles first; `after` is then ready, and the cancel lands before it starts.
        if (e.type === "result" && e.node === "quick") controller.abort();
      },
    });
    cancelling = false;
    const rerun = await execute(g, ctx);
    expect({
      ran: seen,
      statuses: statuses(results),
      keyed: results.filter((r) => resultActionKey(r) !== undefined).map((r) => r.name),
      rerun: statuses(rerun),
    }).toEqual({
      ran: ["slow", "quick", "slow", "after", "never"],
      statuses: { quick: "ran", after: "cancelled", slow: "cancelled", never: "cancelled" },
      keyed: ["quick", "slow"],
      rerun: { quick: "hit", slow: "ran", after: "ran", never: "ran" },
    });
  });

  test("a cancel ends a miss's wait for its group's slot: it settles cancelled and never runs", async () => {
    const { ctx } = setup();
    const controller = new AbortController();
    const ran: string[] = [];
    const g = new Graph<Ports>();
    for (const name of ["holder", "waiter"])
      task(g, name, {
        concurrencyGroup: "heavy",
        run: async (c) => {
          ran.push(name);
          await new Promise((r) => c.signal.addEventListener("abort", r));
          return undefined;
        },
      });
    const results = await execute(g, ctx, {
      signal: controller.signal,
      scheduler: throttledScheduler({ concurrencyLimits: { heavy: 1 } }),
      onEvent: (e) => {
        if (e.type === "start") setTimeout(() => controller.abort(), 5);
      },
    });
    expect({
      ran,
      results: Object.fromEntries(
        results.map((r) => [r.name, [r.status, resultActionKey(r) !== undefined]]),
      ),
    }).toEqual({
      ran: ["holder"],
      results: { holder: ["cancelled", true], waiter: ["cancelled", true] },
    });
  });

  test("with runNode given no signal, a cancel still ends a pending miss's wait: it settles cancelled", async () => {
    const { ctx } = setup();
    const controller = new AbortController();
    const heavy = defineActionWithPorts({
      kind: "heavy",
      nodeInputs: nodeInputs<{ id: number }>,
      concurrencyGroup: "heavy",
      action: async (c) => {
        controller.abort();
        await new Promise((r) => setTimeout(r, 10));
        return { file: await write(c, "f", "x") };
      },
    });
    const g = new Graph<Ports>();
    heavy.addNode(g, { name: "holder", inputs: { id: 1 } });
    heavy.addNode(g, { name: "waiter", inputs: { id: 2 } });
    const results = await orchestrate(
      g.describe(),
      runNode(g, ctx),
      throttledScheduler({ concurrencyLimits: { heavy: 1 } }),
      wallClock,
      undefined,
      controller.signal,
    );
    expect(Object.fromEntries(results.map((r) => [r.name, r.status]))).toEqual({
      holder: "succeeded",
      waiter: "cancelled",
    });
  });

  test("timeoutMs: the action's signal aborts with a TimeoutError, the node fails whatever it returns and is never cached, and the timeout is not in the key", async () => {
    const { ctx } = setup();
    const reasons: string[] = [];
    const build = (quickTimeoutMs: number) => {
      const g = new Graph<Ports>();
      // `hung` waits for its signal and then returns normally, as a test runner that exits 0 on SIGINT does.
      const hung = task(g, "hung", {
        timeoutMs: 20,
        run: (c) =>
          new Promise((resolve) =>
            c.signal.addEventListener("abort", () => {
              const reason: unknown = c.signal.reason;
              reasons.push(reason instanceof Error ? reason.name : String(reason));
              resolve(undefined);
            }),
          ),
      });
      task(g, "quick", { timeoutMs: quickTimeoutMs });
      task(g, "needs", { timeoutMs: 1000, deps: { hung } });
      task(g, "report", { timeoutMs: 1000, deps: { hung: settled(hung) } });
      return g;
    };
    const summarize = (rs: NodeResult[]) =>
      Object.fromEntries(
        rs.map((r) => [
          r.name,
          r.status === "failed" ? [r.status, r.error.name, r.error.message] : outcome(r),
        ]),
      );
    expect({
      first: summarize(await execute(build(1000), ctx)),
      second: summarize(await execute(build(5000), ctx)),
      reasons,
      timeoutOnNode: build(1000)
        .describe()
        .map((n) => [n.name, n.timeoutMs]),
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
      timeoutOnNode: [
        ["hung", 20],
        ["quick", 1000],
        ["needs", 1000],
        ["report", 1000],
      ],
    });
  });

  test("timeoutMs: a cancel that lands after the node's own timeout still decides, as on GitHub", async () => {
    const { ctx } = setup();
    const controller = new AbortController();
    const g = new Graph<Ports>();
    task(g, "late", {
      timeoutMs: 10,
      run: async (c) => {
        await new Promise((resolve) => c.signal.addEventListener("abort", resolve));
        controller.abort();
        return "late";
      },
    });
    const events: string[] = [];
    const [result] = await execute(g, ctx, {
      signal: controller.signal,
      onEvent: (e) => void events.push(e.type === "result" ? e.result.status : e.type),
    });
    assert.ok(result, "the node settles");
    expect({ status: result.status, keyed: resultActionKey(result) !== undefined, events }).toEqual(
      {
        status: "cancelled",
        keyed: true,
        events: ["dispatch", "start", "cancelled"],
      },
    );
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
    const [result] = await execute(g, { ...ctx, fs: slowMkdir }, { signal: controller.signal });
    assert.ok(result, "the node settles");
    expect({ ran, status: result.status, files: [...fs.files.keys()] }).toEqual({
      ran: false,
      status: "cancelled",
      files: [],
    });
  });
});
