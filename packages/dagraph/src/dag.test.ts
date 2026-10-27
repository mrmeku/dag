import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { forcedCache, FsCache, MemCache, type Cache, type DagFs } from "./cache.ts";
import { actionsFor } from "./define-action.ts";
import { execute } from "./execute.ts";
import { fileHandle } from "./file-handle.ts";
import {
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
  type InputRecord,
  type NodeInputs,
  type NodeRef,
  type OutputRef,
  type Outputs,
  type SettledOutputRef,
} from "./graph/index.ts";
import { createBunDagFs } from "./ports/fs.ts";
import { createMemoryDagFs, type MemoryDagFs } from "./ports/memory-fs.ts";
import { createNodeDagFs } from "./ports/node-fs.ts";
import { throttledScheduler } from "./schedulers.ts";
import { isResult, isSucceeded, tally, type ExecEvent, type Result } from "./types.ts";
import { errorMessage } from "./utils.ts";

interface Ports {
  fs: DagFs;
}

type Group = "group_a" | "group_b" | "heavy";

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

function setup(cacheOf: (fs: MemoryDagFs) => Cache = () => new MemCache()) {
  const fs = createMemoryDagFs();
  const cache = cacheOf(fs);
  return { fs, cache, ctx: { ports: { fs }, cache, fs, casBaseDir: "/cas" } };
}

const statuses = (rs: Result[]) => Object.fromEntries(rs.map((r) => [r.name, r.status]));
const counts = (rs: Result[]) => ({ ran: tally(rs).done, hit: tally(rs).cached });
const outputsOf = (r: Result | undefined) =>
  r && isSucceeded(r) ? namedOutput(r.outputs, "out") : "";
/** A result that succeeded; refused when it did not. */
const succeeded = (r: Result | undefined) => {
  assert.ok(r && isSucceeded(r), `${r?.name ?? "the node"} did not succeed`);
  return r;
};
/** The path of a dep's `out`. */
const depPath = (outputs: Outputs | undefined) => {
  assert.ok(outputs !== undefined, "the dep has outputs");
  return namedOutput(outputs, "out");
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

  test("readiness: a dependent starts as soon as its deps finish", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    const log: string[] = [];
    const logged =
      (name: string, ms = 0) =>
      async () => {
        await Bun.sleep(ms);
        log.push(name);
        return name;
      };
    const slowRoot = task(g, "slow_root", { run: logged("slow_root", 50) });
    const fastRoot = task(g, "fast_root", { run: logged("fast_root") });
    task(g, "slow_child", { deps: { slowRoot }, run: logged("slow_child") });
    task(g, "fast_child", { deps: { fastRoot }, run: logged("fast_child") });
    await execute(g, ctx);
    expect(log).toEqual(["fast_root", "fast_child", "slow_root", "slow_child"]);
  });

  test("children of completed nodes run before queued siblings", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    const log: string[] = [];
    const logged = (name: string) => () => (log.push(name), name);
    const first = task(g, "first_root", { run: logged("first_root") });
    task(g, "second_root", { run: logged("second_root") });
    task(g, "child", { deps: { first }, run: logged("child") });
    await execute(g, ctx, { scheduler: throttledScheduler({ maxParallelism: 1 }) });
    expect(log).toEqual(["first_root", "child", "second_root"]);
  });

  test("nodes made ready together run in the order they were added", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    const log: string[] = [];
    const logged = (name: string) => () => (log.push(name), name);
    const root = task(g, "root", { run: logged("root") });
    for (const name of ["c1", "c2", "c3"]) task(g, name, { deps: { root }, run: logged(name) });
    await execute(g, ctx, { scheduler: throttledScheduler({ maxParallelism: 1 }) });
    expect(log).toEqual(["root", "c1", "c2", "c3"]);
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

  test("a failure holds back what requires it, transitively and through a diamond, and nothing else", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    const boom = () => {
      throw new Error("boom");
    };
    const good = task(g, "good_root");
    task(g, "good_child", { deps: { good } });
    const bad = task(g, "bad_root", { run: boom });
    const mid = task(g, "mid", { deps: { bad } });
    task(g, "leaf", { deps: { mid } });
    const top = task(g, "top");
    const left = task(g, "left", { deps: { top }, run: boom });
    const right = task(g, "right", { deps: { top } });
    task(g, "bottom", { deps: { left, right } });

    const results = await execute(g, ctx);
    // A node that ran keeps the key of the CAS dir it wrote to; one held back never computed one.
    expect(
      Object.fromEntries(
        results.map((r) => [
          r.name,
          [r.status, /^[0-9a-f]{64}$/.test(r.actionKey), r.status === "dep-failed" ? r.dep : ""],
        ]),
      ),
    ).toEqual({
      good_root: ["done", true, ""],
      good_child: ["done", true, ""],
      bad_root: ["failed", true, ""],
      mid: ["dep-failed", false, "bad_root"],
      leaf: ["dep-failed", false, "mid"],
      top: ["done", true, ""],
      left: ["failed", true, ""],
      right: ["done", true, ""],
      bottom: ["dep-failed", false, "left"],
    });
  });

  test("maxParallelism caps concurrent execution", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    let peak = 0;
    let inflight = 0;
    for (let i = 0; i < 6; i++)
      task(g, `task_${i}`, {
        run: async () => {
          peak = Math.max(peak, ++inflight);
          await Bun.sleep(20);
          inflight--;
          return undefined;
        },
      });
    const results = await execute(g, ctx, { scheduler: throttledScheduler({ maxParallelism: 2 }) });
    expect({ peak, counts: counts(results) }).toEqual({ peak: 2, counts: { ran: 6, hit: 0 } });
  });

  test("a cache whose reads miss runs every node, and its writes are the next run's entries", async () => {
    const { ctx } = setup();
    const build = () => {
      const g = new Graph<Ports>();
      const a = task(g, "a");
      task(g, "b", { deps: { a } });
      return g;
    };
    expect([
      counts(await execute(build(), ctx)),
      counts(await execute(build(), { ...ctx, cache: forcedCache(ctx.cache) })),
      counts(await execute(build(), ctx)),
    ]).toEqual([
      { ran: 2, hit: 0 },
      { ran: 2, hit: 0 },
      { ran: 0, hit: 2 },
    ]);
  });
});

describe("the action key", () => {
  test("the kind, inputs and deps identify an action: not its function or how-to-run fields, nor the node's name or meta", async () => {
    const { ctx, fs } = setup();
    const make = (kind: string, content: string, group?: Group) =>
      defineActionWithPorts({
        kind,
        inputs: { version: 1 },
        ...(group && { concurrencyGroup: group, timeoutMs: 1000 }),
        action: async (c) => ({ out: await write(c, "out", content) }),
      });
    const first = new Graph<Ports, { video: string }>();
    make("one", "made by one").addNode(first, { name: "a", meta: { video: "x" } });
    const second = new Graph<Ports, { video: string }>();
    make("one", "made again", "heavy").addNode(second.subgraph("v", { video: "y" }), {
      name: "b",
    });
    const third = new Graph<Ports, { video: string }>();
    make("two", "made by two").addNode(third, { name: "a", meta: { video: "x" } });
    const [one] = await execute(first, ctx);
    const [again] = await execute(second, ctx);
    const [two] = await execute(third, ctx);
    assert.ok(one && again && two, "each graph settles its node");
    expect({
      one: one.status,
      again: [again.name, again.status, again.actionKey === one.actionKey],
      two: [two.status, two.actionKey === one.actionKey],
      read: [await fs.readText(outputsOf(again)), await fs.readText(outputsOf(two))],
    }).toEqual({
      one: "done",
      again: ["v:b", "cached", true],
      two: ["done", false],
      read: ["made by one", "made by two"],
    });
  });

  test("deps key by role: renaming nodes re-keys nothing, swapping deps between roles re-keys", async () => {
    const { ctx } = setup();
    const build = (names: [string, string], swap = false) => {
      const g = new Graph<Ports>();
      const a = task(g, names[0], { inputs: { id: "A" } });
      const b = task(g, names[1], { inputs: { id: "B" } });
      task(g, "join", { deps: swap ? { left: b, right: a } : { left: a, right: b } });
      return g;
    };
    expect([
      statuses(await execute(build(["a", "b"]), ctx)),
      statuses(await execute(build(["x", "y"]), ctx)),
      statuses(await execute(build(["x", "y"], true), ctx)),
    ]).toEqual([
      { a: "done", b: "done", join: "done" },
      { x: "cached", y: "cached", join: "cached" },
      { x: "cached", y: "cached", join: "done" },
    ]);
  });

  test("a value input keys as JSON with sorted keys, undefined properties dropped, and reads as written", async () => {
    const { ctx, fs } = setup();
    const run = async (inputs: InputRecord) => {
      const g = new Graph<Ports>();
      task(g, "n", { inputs });
      const [r] = await execute(g, ctx);
      assert.ok(r, "the node settles");
      return [r.status, await fs.readText(outputsOf(r))];
    };
    expect([
      await run({ opts: { a: 1, b: [1, 2] } }),
      await run({ opts: { b: [1, 2], a: 1, c: undefined }, gone: undefined }),
      await run({ opts: { a: "1", b: [1, 2] } }),
      await run({ opts: { a: 1, b: [2, 1] } }),
    ]).toEqual([
      ["done", '{"id":"n","opts":{"a":1,"b":[1,2]}}'],
      ["cached", '{"id":"n","opts":{"a":1,"b":[1,2]}}'],
      ["done", '{"id":"n","opts":{"a":"1","b":[1,2]}}'],
      ["done", '{"id":"n","opts":{"a":1,"b":[2,1]}}'],
    ]);
  });

  test("a file input keys on its path and content, reads as a handle on the file, and is hashed by each node that declares it", async () => {
    const { ctx, fs } = setup();
    const hashed: string[] = [];
    const counting = {
      ...ctx,
      fs: { ...fs, hashFile: (p: string) => (hashed.push(p), fs.hashFile(p)) },
    };
    await fs.writeText("/src/a.ts", "a1");
    const reader = defineActionWithPorts({
      kind: "reader",
      nodeInputs: nodeInputs<{ id: string; src: FileInput }>,
      action: async (c) => ({
        out: await write(c, "out", `${c.inputs.src.path}: ${await c.inputs.src.text()}`),
      }),
    });
    const run = async (add: (g: Graph<Ports>, name: string) => void) => {
      const g = new Graph<Ports>();
      for (const name of ["one", "two", "three"]) add(g, name);
      const results = await execute(g, counting);
      return [statuses(results), await fs.readText(outputsOf(results[0]))];
    };
    const asFile = (g: Graph<Ports>, name: string) =>
      reader.addNode(g, { name, inputs: { id: name, src: file("/src/a.ts") } });
    const first = await run(asFile);
    const firstHashed = hashed.filter((p) => p === "/src/a.ts").length;
    const same = await run(asFile);
    await fs.writeText("/src/a.ts", "a2");
    const edited = await run(asFile);
    const asValue = await run((g, name) => task(g, name, { inputs: { src: "/src/a.ts" } }));
    const ran = { one: "done", two: "done", three: "done" } as const;
    expect({ first, firstHashed, same, edited, asValue }).toEqual({
      first: [ran, "/src/a.ts: a1"],
      firstHashed: 3,
      same: [{ one: "cached", two: "cached", three: "cached" }, "/src/a.ts: a1"],
      edited: [ran, "/src/a.ts: a2"],
      asValue: [ran, '{"id":"one","src":"/src/a.ts"}'],
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
      return [late?.status, await fs.readText(outputsOf(late))];
    };
    expect([await run("one"), await run("two")]).toEqual([
      ["done", "one"],
      ["done", "two"],
    ]);
  });

  test("an output ref reads as a handle on the dep's published file and keys by role and output name, not by its path, so a dep rebuilt to the same content keeps it cached", async () => {
    const { ctx, fs } = setup();
    const pack = defineActionWithPorts({
      kind: "pack",
      nodeInputs: nodeInputs<{ version: string }>,
      action: async (c) => ({
        tarball: await write(c, "pkg.tgz", "pkg"),
        notes: await write(c, "notes.md", "notes"),
      }),
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
    const run = async (version: string) => {
      const g = new Graph<Ports>();
      const p = pack.addNode(g, { inputs: { version } });
      publish.addNode(g, {
        deps: { pack: p },
        inputs: ({ pack }) => ({ cmd: ["npm", "publish", pack.tarball] }),
      });
      const results = await execute(g, ctx);
      const [packed, published] = results;
      const tarball = namedOutput(succeeded(packed).outputs, "tarball");
      return {
        statuses: statuses(results),
        reads:
          (await fs.readText(outputsOf(published))) === JSON.stringify(["npm", "publish", tarball]),
      };
    };
    expect([await run("1.0"), await run("1.1")]).toEqual([
      { statuses: { pack: "done", publish: "done" }, reads: true },
      { statuses: { pack: "done", publish: "cached" }, reads: false },
    ]);
  });
});

describe("refs and outputs in the key", () => {
  test("a role that picks some of its dep's outputs keys on those alone and reads only those, settled or maybe", async () => {
    const { ctx } = setup();
    const pair = defineActionWithPorts({
      kind: "pair-of-files",
      nodeInputs: nodeInputs<{ main: string; extra: string }>,
      action: async (c) => ({
        main: await write(c, "main.txt", c.inputs.main),
        extra: await write(c, "extra.txt", c.inputs.extra),
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
    const run = async (main: string, extra: string) => {
      const g = new Graph<Ports>();
      const p = pair.addNode(g, { inputs: { main, extra } });
      required.addNode(g, { deps: { pair: p } });
      settledRole.addNode(g, { deps: { pair: settled(p) } });
      maybeRole.addNode(g, { deps: { pair: p } });
      return statuses(await execute(g, ctx));
    };
    const first = await run("a", "x");
    const readFirst = read.splice(0);
    expect({
      first,
      readFirst,
      extraChanged: await run("a", "y"),
      mainChanged: await run("b", "y"),
    }).toEqual({
      first: { "pair-of-files": "done", required: "done", settled: "done", maybe: "done" },
      readFirst: [
        ["required", "main"],
        ["settled", "main"],
        ["maybe", "main"],
      ],
      extraChanged: {
        "pair-of-files": "done",
        required: "cached",
        settled: "cached",
        maybe: "cached",
      },
      mainChanged: { "pair-of-files": "done", required: "done", settled: "done", maybe: "done" },
    });
  });

  type Pair = { main: string; extra: string };
  const pair = defineActionWithPorts({
    kind: "pair",
    inputs: { version: 1 },
    action: async (c) => ({
      main: await write(c, "m", "same"),
      extra: await write(c, "e", "same"),
    }),
  });
  /** The key of `use`, a node `declare` adds beside p and q, two nodes of `pair`. */
  const keyOfUse = async (
    ctx: ReturnType<typeof setup>["ctx"],
    names: [string, string],
    declare: (g: Graph<Ports>, p: NodeRef<Pair>, q: NodeRef<Pair>) => void,
  ) => {
    // p and q share one declaration, so one entry: they differ in name and role only.
    const g = new Graph<Ports>();
    declare(g, pair.addNode(g, { name: names[0] }), pair.addNode(g, { name: names[1] }));
    const use = (await execute(g, ctx)).find((r) => r.name === "use");
    assert.ok(use, "use settles");
    return use.actionKey;
  };
  const leftAndRight =
    (role: "left" | "right", output: keyof Pair) =>
    (g: Graph<Ports>, p: NodeRef<Pair>, q: NodeRef<Pair>) =>
      void task(g, "use", {
        deps: { left: p, right: q },
        inputs: (refs) => ({ file: refs[role][output] }),
      });
  const twoRoles =
    (role: "main" | "alias", deps: "same" | "reordered" | "split") =>
    (g: Graph<Ports>, p: NodeRef<Pair>, q: NodeRef<Pair>) =>
      void task(g, "use", {
        deps: {
          same: { main: p, alias: p },
          reordered: { alias: p, main: p },
          split: { main: p, alias: q },
        }[deps],
        inputs: (refs) => ({ file: refs[role].main }),
      });

  test("an output ref keys by the role it points through and its output's name, never by its node's name or by the output name alone", async () => {
    const { ctx } = setup();
    const leftMain = await keyOfUse(ctx, ["p", "q"], leftAndRight("left", "main"));
    expect({
      renamed: (await keyOfUse(ctx, ["x", "y"], leftAndRight("left", "main"))) === leftMain,
      otherOutput: (await keyOfUse(ctx, ["p", "q"], leftAndRight("left", "extra"))) === leftMain,
      otherRole: (await keyOfUse(ctx, ["p", "q"], leftAndRight("right", "main"))) === leftMain,
    }).toEqual({ renamed: true, otherOutput: false, otherRole: false });
  });

  test("a ref to a node two roles name keys by all its roles, in sorted order, through either role", async () => {
    const { ctx } = setup();
    const both = await keyOfUse(ctx, ["p", "q"], twoRoles("main", "same"));
    expect({
      reordered: (await keyOfUse(ctx, ["p", "q"], twoRoles("main", "reordered"))) === both,
      throughAlias: (await keyOfUse(ctx, ["p", "q"], twoRoles("alias", "same"))) === both,
      oneRole: (await keyOfUse(ctx, ["p", "q"], twoRoles("main", "split"))) === both,
    }).toEqual({ reordered: true, throughAlias: true, oneRole: false });
  });

  test("a ref from the inputs function keys as the same ref written from its node did", async () => {
    const { ctx } = setup();
    // The keys these nodes had when their refs were written as p.outputs.main (25a5ee4), but
    // for their kind, which joined the key later.
    expect({
      leftMain: await keyOfUse(ctx, ["p", "q"], leftAndRight("left", "main")),
      twoRoles: await keyOfUse(ctx, ["p", "q"], twoRoles("main", "same")),
    }).toEqual({
      leftMain: "592dd623a1ac0eddbeac5e2ff3a61046869ecc409f520fd7057efdebc71564a3",
      twoRoles: "b97bb03bf57c20b783a577f3f5d9efacdc3cc760527f8e01df06ab27acd0ab76",
    });
  });

  test("a content hash covers each output's name, each file's path in its output dir and its content, wherever the dir sits", async () => {
    const { ctx } = setup();
    const hashOf = async (version: number, files: Record<string, [string, string]>) => {
      const g = new Graph<Ports>();
      defineActionWithPorts({
        kind: "producer",
        inputs: { version },
        action: async (c) => {
          const outputs: Record<string, string> = {};
          for (const [name, [path, content]] of Object.entries(files))
            outputs[name] = await write(c, path, content);
          return outputs;
        },
      }).addNode(g, {});
      const [r] = await execute(g, ctx);
      return succeeded(r).contentHash;
    };
    const base = await hashOf(1, { main: ["x.txt", "A"], extra: ["y.txt", "B"] });
    expect({
      elsewhere: (await hashOf(2, { main: ["x.txt", "A"], extra: ["y.txt", "B"] })) === base,
      swapped: (await hashOf(3, { main: ["y.txt", "B"], extra: ["x.txt", "A"] })) === base,
      moved: (await hashOf(4, { main: ["z.txt", "A"], extra: ["y.txt", "B"] })) === base,
      renamed: (await hashOf(5, { first: ["x.txt", "A"], extra: ["y.txt", "B"] })) === base,
      edited: (await hashOf(6, { main: ["x.txt", "C"], extra: ["y.txt", "B"] })) === base,
    }).toEqual({ elsewhere: true, swapped: false, moved: false, renamed: false, edited: false });
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
          r.status === "failed" ? [r.status, r.actionKey, r.error.message] : r.status,
        ]),
      ),
    ).toEqual({
      unreadable: ["failed", "", "ENOENT: /missing.ts"],
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
    const outputs = succeeded(recorded).outputs;
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
    const outputs = succeeded(made).outputs;
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
    const fs = createMemoryDagFs(files);
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

describe("the CAS", () => {
  test("an action writes into a private dir, renamed to {key}/out-{contentHash} beside the manifest when it succeeds, so an output named manifest.json still caches, and removed when it fails", async () => {
    const { ctx, fs } = setup((fs) => new FsCache("/cas", fs));
    const seen: string[] = [];
    const build = () => {
      const g = new Graph<Ports>();
      defineActionWithPorts({
        kind: "m",
        action: async (c) => {
          seen.push(c.outputDir);
          return { out: await write(c, "manifest.json", "an output, not the cache entry") };
        },
      }).addNode(g, {});
      task(g, "broken", {
        run: async (c) => {
          await write(c, "partial", "half");
          throw new Error("broken");
        },
      });
      return g;
    };
    const m = succeeded((await execute(build(), ctx)).find((r) => r.name === "m"));
    const second = await execute(build(), ctx);
    const dir = `/cas/${m.actionKey}`;
    const [outputDir] = seen;
    assert.ok(outputDir, "the action saw its output dir");
    expect({
      outputDir: outputDir.replace(/[0-9a-f-]{36}$/, "<uuid>"),
      outputs: outputsOf(m),
      second: statuses(second),
      files: [...fs.files.keys()].sort(),
    }).toEqual({
      outputDir: `${dir}/tmp-<uuid>`,
      outputs: `${dir}/out-${m.contentHash}/manifest.json`,
      second: { m: "cached", broken: "failed" },
      files: [`${dir}/manifest.json`, `${dir}/out-${m.contentHash}/manifest.json`],
    });
  });

  test("a returned path outside the output dir, or outputs that are no record, fail the node", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    const returning = (name: string, path: (c: ActionContext<Ports>) => Promise<string>) =>
      defineActionWithPorts({
        kind: name,
        action: async (c) => ({ out: await path(c) }),
      }).addNode(g, {
        inputs: { id: name },
      });
    returning("escapes", (c) => write(c, "../sibling", "x"));
    returning(
      "elsewhere",
      async (c) => (await c.ports.fs.writeText("/elsewhere", "x"), "/elsewhere"),
    );
    // @ts-expect-error a bare path is no record of outputs: return { out: path }
    defineActionWithPorts({ kind: "bare", action: async () => "x" }).addNode(g, {});
    const results = await execute(g, ctx);
    expect(
      Object.fromEntries(
        results.map((r) => [r.name, r.status === "failed" && r.error.message.split(":")[0]]),
      ),
    ).toEqual({
      escapes: "output not under the output dir",
      elsewhere: "output not under the output dir",
      bare: 'the action returned "x", not a record of outputs',
    });
  });

  test("FsCache: a manifest whose outputs are no record, as a bare path or a list once stored, reads as a miss", async () => {
    const fs = createMemoryDagFs();
    const cache = new FsCache("/cas", fs);
    const stored = { bare: "/cas/bare/out-1/f", list: ["/cas/list/out-1/f"] };
    for (const [key, outputs] of Object.entries(stored))
      await fs.writeText(
        `/cas/${key}/manifest.json`,
        JSON.stringify({ outputs, contentHash: "1", outputHashes: {} }),
      );
    expect([await cache.get("bare"), await cache.get("list")]).toEqual([undefined, undefined]);
  });

  test("FsCache: a get while a put is half written sees the old entry, then the new one", async () => {
    const base = createMemoryDagFs();
    const halfWritten = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const fs: DagFs = {
      ...base,
      writeText: async (path, content) => {
        await base.writeText(path, content.slice(0, content.length / 2));
        halfWritten.resolve();
        await resume.promise;
        await base.writeText(path, content);
      },
    };
    const old = { outputs: { out: "/cas/k/out-1/f" }, contentHash: "1", outputHashes: {} };
    const next = { outputs: { out: "/cas/k/out-2/f" }, contentHash: "2", outputHashes: {} };
    await new FsCache("/cas", base).put("k", old);
    const cache = new FsCache("/cas", fs);
    const putting = cache.put("k", next);
    await halfWritten.promise;
    const during = await cache.get("k");
    resume.resolve();
    await putting;
    expect({ during, after: await cache.get("k") }).toEqual({ during: old, after: next });
  });

  test("two attempts of one key both keep their published files, and a key's older directories stay after a new attempt publishes", async () => {
    const { ctx, fs, cache } = setup((fs) => new FsCache("/cas", fs));
    let calls = 0;
    const chapters = defineActionWithPorts({
      kind: "chapters",
      inputs: { version: "chapters-v1" },
      action: async (c) => ({ out: await write(c, "chapters.json", "[]") }),
    });
    const clean = defineActionWithPorts({
      kind: "clean_description",
      inputs: { version: "clean-v1", prompt: "clean" },
      action: async (c) => ({ out: await write(c, "description.txt", `call ${++calls}`) }),
    });
    const upload = defineActionWithPorts({
      kind: "upload",
      cacheable: false,
      inputs: { version: "upload-v1" },
      action: async (c) => ({ out: await write(c, "id.txt", `call ${++calls}`) }),
    });
    const build = (videos: string[]) => {
      const g = new Graph<Ports>();
      for (const video of videos) {
        const sg = g.subgraph(video);
        chapters.addNode(sg, {});
        clean.addNode(sg, {});
        upload.addNode(sg, {});
      }
      return g;
    };
    const by = (rs: Result[]) => Object.fromEntries(rs.map((r) => [r.name, r]));
    const first = by(await execute(build(["v1", "v2"]), ctx));
    const both = (node: string) => [first[`v1:${node}`], first[`v2:${node}`]].map(outputsOf);
    const cleaned = first["v1:clean_description"];
    assert.ok(cleaned, "v1:clean_description settles");
    const entry = await cache.get(cleaned.actionKey);
    const together = {
      statuses: Object.values(first).map((r) => r.status),
      chapters: new Set(both("chapters")).size,
      cleaned: await Promise.all(both("clean_description").map((p) => fs.exists(p))),
      entry: both("clean_description").includes(depPath(entry?.outputs)),
      uploaded: await Promise.all(both("upload").map((p) => fs.exists(p))),
    };
    const next = by(await execute(build(["v1"]), { ...ctx, cache: forcedCache(cache) }));
    const dirsOf = async (node: string) => {
      const r = succeeded(next[`v1:${node}`]);
      const dirs = await fs.readdir(`/cas/${r.actionKey}`);
      const own = `out-${r.contentHash}`;
      return dirs
        .map((d) => (d === own ? "out-<its own>" : d.startsWith("out-") ? "out-<earlier>" : d))
        .sort();
    };
    expect({
      together,
      chapters: await dirsOf("chapters"),
      clean: await dirsOf("clean_description"),
      upload: await dirsOf("upload"),
    }).toEqual({
      together: {
        statuses: ["done", "done", "done", "done", "done", "done"],
        chapters: 1,
        cleaned: [true, true],
        entry: true,
        uploaded: [true, true],
      },
      chapters: ["manifest.json", "out-<its own>"],
      clean: ["manifest.json", "out-<earlier>", "out-<earlier>", "out-<its own>"],
      upload: ["out-<earlier>", "out-<earlier>", "out-<its own>"],
    });
  });

  test("a casBaseDir with a trailing slash is the same directory", async () => {
    const { ctx } = setup();
    const run = async (casBaseDir: string) => {
      const g = new Graph<Ports>();
      task(g, "a");
      const [r] = await execute(g, { ...ctx, casBaseDir });
      assert.ok(r, "the node settles");
      return [r.status, outputsOf(r).startsWith(`/cas/${r.actionKey}/out-`)];
    };
    expect([await run("/cas/"), await run("/cas")]).toEqual([
      ["done", true],
      ["cached", true],
    ]);
  });

  test("a cache whose get rejects is a miss, never a failure", async () => {
    const { ctx } = setup();
    const memory = new MemCache();
    const unreachable: Cache = {
      get: async () => {
        throw new Error("remote unreachable");
      },
      put: (key, entry) => memory.put(key, entry),
    };
    const g = new Graph<Ports>();
    task(g, "a");
    const [r] = await execute(g, { ...ctx, cache: unreachable });
    assert.ok(r, "the node settles");
    expect([r.status, (await memory.get(r.actionKey))?.outputs["out"] === outputsOf(r)]).toEqual([
      "done",
      true,
    ]);
  });

  test("under a relative casBaseDir, the action sees absolute paths, the manifest and the result hold relative ones in either form it returned, and the CAS restored under another working directory still hits", async () => {
    const fs = createNodeDagFs();
    const tmp = await realpath(await mkdtemp(join(tmpdir(), "dagraph-")));
    const home = process.cwd();
    const casBaseDir = "cas";
    const c = { ports: { fs }, cache: new FsCache(casBaseDir, fs), fs, casBaseDir };
    type Written = { joined: string; relative: string };
    const seen: { outputDir?: string; handle?: string } = {};
    const build = () => {
      const g = new Graph<Ports>();
      const written = defineActionWithPorts({
        kind: "written",
        action: async (c) => {
          seen.outputDir = c.outputDir;
          const joined = join(c.outputDir, "srt");
          const relativePath = relative(process.cwd(), join(c.outputDir, "b"));
          await c.ports.fs.writeText(joined, "subtitles");
          await c.ports.fs.writeText(relativePath, "b");
          return { joined, relative: relativePath };
        },
      }).addNode(g, {});
      defineActionWithPorts({
        kind: "reader",
        deps: { written: dep<Written> },
        action: async (c) => {
          seen.handle = c.depOutputs.written.joined.path;
          return { out: await write(c, "out", await c.depOutputs.written.joined.text()) };
        },
      }).addNode(g, { deps: { written } });
      return g;
    };
    const runIn = async (dir: string) => {
      await mkdir(dir, { recursive: true });
      process.chdir(dir);
      try {
        return await execute(build(), c);
      } finally {
        process.chdir(home);
      }
    };
    try {
      const first = await runIn(`${tmp}/first`);
      const w = succeeded(first.find((r) => r.name === "written"));
      const keyDir = join(casBaseDir, w.actionKey);
      const manifest: unknown = JSON.parse(
        await fs.readText(`${tmp}/first/${keyDir}/manifest.json`),
      );
      // Only the copy is left, so an entry that named the first tree's files would miss.
      await cp(`${tmp}/first`, `${tmp}/restored`, { recursive: true });
      await rm(`${tmp}/first`, { recursive: true });
      const restored = await runIn(`${tmp}/restored`);
      const dir = `${keyDir}/out-${w.contentHash}`;
      const outputs = { joined: `${dir}/srt`, relative: `${dir}/b` };
      expect({
        first: statuses(first),
        restored: statuses(restored),
        outputDir: seen.outputDir?.replace(/[0-9a-f-]{36}$/, "<uuid>"),
        handle: seen.handle,
        manifest,
        result: w.outputs,
      }).toEqual({
        first: { written: "done", reader: "done" },
        restored: { written: "cached", reader: "cached" },
        outputDir: `${tmp}/first/${keyDir}/tmp-<uuid>`,
        handle: `${tmp}/first/${dir}/srt`,
        manifest: { outputs, contentHash: w.contentHash, outputHashes: w.outputHashes },
        result: outputs,
      });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  const filesystems: [string, () => DagFs][] = [
    ["memory", createMemoryDagFs],
    ["Bun", createBunDagFs],
    ["Node", createNodeDagFs],
  ];
  for (const [label, createFs] of filesystems)
    test(`${label} fs: a concurrent run that rewrites its output while another run's dependent reads it never poisons that dependent's entry`, async () => {
      const fs = createFs();
      const casBaseDir = `${await mkdtemp(join(tmpdir(), "dagraph-"))}/cas`;
      const c = { ports: { fs }, cache: new FsCache(casBaseDir, fs), fs, casBaseDir };
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
      const read = double?.status === "cached" && (await fs.readText(outputsOf(double)));
      await rm(dirname(casBaseDir), { recursive: true, force: true });
      expect({ statuses: statuses(third), double: read }).toEqual({
        statuses: { count: "cached", double: "cached" },
        double: "84",
      });
    });

  /** Each node's error message, or its status when it did not fail. */
  const errors = (rs: Result[]) =>
    Object.fromEntries(rs.map((r) => [r.name, r.status === "failed" ? r.error.message : r.status]));

  for (const [label, createFs] of filesystems)
    test(`${label} fs: a returned path with no file fails its node, naming the output and its file, and the failure is never cached`, async () => {
      const fs = createFs();
      const casBaseDir = `${await mkdtemp(join(tmpdir(), "dagraph-"))}/cas`;
      const c = { ports: { fs }, cache: new FsCache(casBaseDir, fs), fs, casBaseDir };
      const build = () => {
        const g = new Graph<Ports>();
        defineActionWithPorts({
          kind: "download",
          inputs: { id: "download" },
          action: async (c) => ({
            audio: await write(c, "audio.mp3", "mp3"),
            thumb: `${c.outputDir}/audio.jpg`,
          }),
        }).addNode(g, {});
        defineActionWithPorts({
          kind: "thumbnail",
          inputs: { id: "thumbnail" },
          action: async (c) => ({ art: `${c.outputDir}/art/audio.jpg` }),
        }).addNode(g, {});
        return g;
      };
      const first = await execute(build(), c);
      const second = await execute(build(), c);
      const entries = await Promise.all(second.map((r) => c.cache.get(r.actionKey)));
      await rm(dirname(casBaseDir), { recursive: true, force: true });
      const fix = (file: string) =>
        `Write it at \`\${outputDir}/${file}\` before the action returns.`;
      const failed = {
        download: `output "thumb" (audio.jpg) was not written. ${fix("audio.jpg")}`,
        thumbnail: `output "art" (art/audio.jpg) was not written. ${fix("art/audio.jpg")}`,
      };
      expect({ first: errors(first), second: errors(second), entries }).toEqual({
        first: failed,
        second: failed,
        entries: [undefined, undefined],
      });
    });

  for (const [label, createFs] of filesystems.filter(([label]) => label !== "memory"))
    test(`${label} fs: a returned path that cannot be read for another reason keeps its own error`, async () => {
      const fs = createFs();
      const casBaseDir = `${await mkdtemp(join(tmpdir(), "dagraph-"))}/cas`;
      const c = { ports: { fs }, cache: new FsCache(casBaseDir, fs), fs, casBaseDir };
      const g = new Graph<Ports>();
      defineActionWithPorts({
        kind: "frames",
        action: async (c) => {
          await c.ports.fs.ensureDir(`${c.outputDir}/frames`);
          return { frames: `${c.outputDir}/frames` };
        },
      }).addNode(g, {});
      const results = await execute(g, c);
      await rm(dirname(casBaseDir), { recursive: true, force: true });
      expect(results.map((r) => r.status === "failed" && r.error.message.split(":")[0])).toEqual([
        "EISDIR",
      ]);
    });
});

describe("cacheable: false", () => {
  test("runs every time, never stores an entry, and downstream still caches by content", async () => {
    const { ctx, cache } = setup();
    const build = () => {
      const g = new Graph<Ports>();
      const probe = task(g, "probe", { cacheable: false, run: () => "same-every-time" });
      task(g, "report", { deps: { probe } });
      return g;
    };
    await execute(build(), ctx);
    const second = await execute(build(), ctx);
    const probe = second.find((r) => r.name === "probe");
    assert.ok(probe, "probe settles");
    expect({
      second: statuses(second),
      stored: await cache.get(probe.actionKey),
    }).toEqual({ second: { probe: "done", report: "cached" }, stored: undefined });
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
    { a: "done", b: "done", c: "done" },
    { a: "done", b: "cached", c: "cached" },
    { a: "done", b: "done", c: "cached" },
  ]);
});

describe("events", () => {
  test("a node's dispatch, start, output and result come in that order, each named by node with its meta; start is live while other nodes run, a cached node never starts, and what prints after the result is dropped", async () => {
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
      onEvent: (e: ExecEvent<{ video: string }>) => {
        const detail = e.type === "output" ? e.chunk : e.type === "result" ? e.result.status : "";
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
        ["result", "v1:warm", "v1", "cached"],
      ],
      fast: [
        ["dispatch", "v1:fast", "v1", ""],
        ["start", "v1:fast", "v1", ""],
        ["output", "v1:fast", "v1", "one\n"],
        ["output", "v1:fast", "v1", "two"],
        ["result", "v1:fast", "v1", "done"],
      ],
      slow: [
        ["dispatch", "slow", "", ""],
        ["start", "slow", "", ""],
        ["result", "slow", "", "done"],
      ],
      slowWhenFastSettled: [
        ["dispatch", "slow", "", ""],
        ["start", "slow", "", ""],
      ],
    });
  });

  test("a failure keeps the thrown error's name, message and cause; a timeout is a TimeoutError that keeps the cause", async () => {
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
    const results = await execute(g, ctx);
    expect(
      results.map((r) => (r.status === "failed" ? [r.name, r.error] : [r.name, r.status])),
    ).toEqual([
      ["bad", { name: "RangeError", message: "bad exited 1", cause: { argv: ["bad"], code: 1 } }],
      [
        "slow",
        {
          name: "TimeoutError",
          message: "timed out after 5 ms",
          cause: { argv: ["slow"], code: 1 },
        },
      ],
    ]);
  });
});

describe("a result is plain data", () => {
  test("a failure's cause is JSON as the engine builds it: JSON copied, an Error as its name, message and cause, anything else dropped; a result of every status survives JSON and reads back as a result", async () => {
    const { ctx } = setup();
    const errorLoop = new Error("first");
    errorLoop.cause = new Error("second", { cause: errorLoop });
    const objectLoop: Record<string, unknown> = { code: 1 };
    objectLoop.self = objectLoop;
    const mutated: Record<string, unknown> = { code: 1 };
    const causes: Record<string, unknown> = {
      command: { argv: ["bun", "test"], cwd: ".", code: 1 },
      nested: new TypeError("inner", {
        cause: new RangeError("innermost", { cause: { code: 2 } }),
      }),
      errorLoop,
      objectLoop,
      bigint: 1n,
      instance: new Map([["code", 1]]),
      nan: { ratio: NaN },
      unreadable: {
        get code(): number {
          throw new Error("not now");
        },
      },
      mutated,
      normalized: { code: -0, signal: undefined },
    };
    const g = new Graph<Ports>();
    const failing = Object.fromEntries(
      Object.entries(causes).map(([name, cause]) => [
        name,
        task(g, name, {
          run: () => {
            throw new Error(`${name} failed`, { cause });
          },
        }),
      ]),
    );
    task(g, "made");
    task(g, "held", { deps: { command: failing.command } });
    const first = await execute(g, ctx);
    // The action changes its cause after the failure: the recorded one is a copy.
    mutated.code = 2;
    mutated.late = 1n;
    const results = [
      ...first,
      ...(await execute(g, ctx)),
      ...(await execute(g, ctx, { signal: AbortSignal.abort() })),
    ];
    const received: unknown = JSON.parse(JSON.stringify(results));
    const dropped = (name: string) => ({ name: "Error", message: `${name} failed` });
    expect({
      errors: Object.fromEntries(
        first.flatMap((r) => (r.status === "failed" ? [[r.name, r.error]] : [])),
      ),
      tally: tally(results),
      received,
      everyIsResult: Array.isArray(received) && received.every(isResult),
    }).toStrictEqual({
      errors: {
        command: {
          name: "Error",
          message: "command failed",
          cause: { argv: ["bun", "test"], cwd: ".", code: 1 },
        },
        nested: {
          name: "Error",
          message: "nested failed",
          cause: {
            name: "TypeError",
            message: "inner",
            cause: { name: "RangeError", message: "innermost", cause: { code: 2 } },
          },
        },
        // The chain stops at the error that comes again.
        errorLoop: {
          name: "Error",
          message: "errorLoop failed",
          cause: { name: "Error", message: "first", cause: { name: "Error", message: "second" } },
        },
        objectLoop: dropped("objectLoop"),
        bigint: dropped("bigint"),
        instance: dropped("instance"),
        nan: dropped("nan"),
        unreadable: dropped("unreadable"),
        mutated: { name: "Error", message: "mutated failed", cause: { code: 1 } },
        normalized: { name: "Error", message: "normalized failed", cause: { code: 0 } },
      },
      tally: { done: 1, cached: 1, failed: 20, "dep-failed": 2, cancelled: 12 },
      received: results,
      everyIsResult: true,
    });
  });

  test("isResult refuses a record that lacks a field its status needs, or whose status no result has", () => {
    const outputs = { out: "/o" };
    const cached = {
      name: "a",
      actionKey: "k",
      status: "cached",
      outputs,
      contentHash: "h",
      outputHashes: {},
    };
    const records = {
      // Only a node that ran has an elapsed time.
      cached,
      doneWithoutElapsed: { ...cached, status: "done" },
      cachedWithoutHash: { name: "a", actionKey: "k", status: "cached", outputs },
      outputsNotPaths: { ...cached, outputs: { out: 1 } },
      outputsNotRecord: { ...cached, outputs: "/o" },
      failedWithoutMessage: {
        name: "a",
        actionKey: "k",
        status: "failed",
        error: { name: "Error" },
        elapsed: 1,
      },
      causeNotJson: {
        name: "a",
        actionKey: "k",
        status: "failed",
        error: { name: "Error", message: "m", cause: 1n },
        elapsed: 1,
      },
      depFailedWithoutDep: { name: "a", actionKey: "", status: "dep-failed" },
      withoutActionKey: { name: "a", status: "cancelled" },
      unknownStatus: { name: "a", actionKey: "", status: "skipped" },
    };
    expect(Object.fromEntries(Object.entries(records).map(([k, v]) => [k, isResult(v)]))).toEqual({
      cached: true,
      doneWithoutElapsed: false,
      cachedWithoutHash: false,
      outputsNotPaths: false,
      outputsNotRecord: false,
      failedWithoutMessage: false,
      causeNotJson: false,
      depFailedWithoutDep: false,
      withoutActionKey: false,
      unknownStatus: false,
    });
  });
});

describe("verify outputs on a cache hit", () => {
  test("a deleted or changed output re-runs the node", async () => {
    const { ctx, fs } = setup();
    const run = async () => {
      const g = new Graph<Ports>();
      task(g, "a", { run: () => "original" });
      const [r] = await execute(g, ctx);
      assert.ok(r, "the node settles");
      return r;
    };
    const first = await run();
    await fs.remove(outputsOf(first));
    const deleted = await run();
    await fs.writeText(outputsOf(deleted), "tampered");
    const changed = await run();
    expect([first.status, deleted.status, changed.status, (await run()).status]).toEqual([
      "done",
      "done",
      "done",
      "cached",
    ]);
  });

  test("a damaged copy in the CAS re-runs the node, whose own copy then stands in for it", async () => {
    const { ctx, fs } = setup();
    const seen: string[] = [];
    const run = async () => {
      const g = new Graph<Ports>();
      task(g, "a", { run: (c) => (seen.push(c.outputDir), "original") });
      const [r] = await execute(g, ctx);
      assert.ok(r, "the node settles");
      return [r.status, outputsOf(r)] as const;
    };
    const [, path] = await run();
    await fs.writeText(path, "x");
    const second = await run();
    const third = await run();
    expect({ second, third, content: await fs.readText(`${seen[1]}/out`) }).toEqual({
      second: ["done", `${seen[1]}/out`],
      third: ["cached", `${seen[1]}/out`],
      content: "original",
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
      results.map((r) => [r.name, r.status === "failed" ? r.error.message : r.status]),
    ),
  }).toEqual({
    ranWhileRecording: [],
    ran: ["recorded"],
    results: { recorded: "done", unrecorded: "the journal is full" },
  });
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
    await execute(build(), ctx, { onEvent: (e) => e.type === "start" && started.push(e.node) }),
  );
  expect({ first, second, started }).toEqual({
    first: { a: "done", b: "failed", c: "dep-failed", d: "dep-failed" },
    second: { a: "cached", b: "done", c: "done", d: "done" },
    started: ["b", "c", "d"],
  });
});

describe("concurrency groups", () => {
  const peakOf = () => {
    let inflight = 0;
    const peak = { value: 0 };
    const run = async () => {
      peak.value = Math.max(peak.value, ++inflight);
      await Bun.sleep(20);
      inflight--;
      return undefined;
    };
    return { peak, run };
  };

  test("each group's limit holds on its own, beside ungrouped nodes running at full parallelism", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    const a = peakOf();
    const b = peakOf();
    const total = peakOf();
    for (let i = 0; i < 4; i++) {
      task(g, `a_${i}`, { concurrencyGroup: "group_a", run: () => (total.run(), a.run()) });
      task(g, `b_${i}`, { concurrencyGroup: "group_b", run: () => (total.run(), b.run()) });
      task(g, `free_${i}`, { run: total.run });
    }
    const results = await execute(g, ctx, {
      scheduler: throttledScheduler({
        maxParallelism: 12,
        concurrencyLimits: { group_a: 1, group_b: 2 },
      }),
    });
    expect({
      a: a.peak.value,
      b: b.peak.value,
      total: total.peak.value > 3,
      ...counts(results),
    }).toEqual({
      a: 1,
      b: 2,
      total: true,
      ran: 12,
      hit: 0,
    });
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
      { captions: "failed", entry: "done" },
      { captions: "failed", entry: "cached" },
      { captions: "done", entry: "done" },
      { captions: "cached", entry: "cached" },
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
      statuses: statuses(await execute(g, { ...ctx, cache: new MemCache() })),
    };
  };
  const ok = await run();
  broken = true;
  expect({ ok, srcBroken: await run(), runs }).toEqual({
    ok: { described: ["src"], statuses: { src: "done", both: "done" } },
    srcBroken: { described: ["src"], statuses: { src: "failed", both: "dep-failed" } },
    runs: [true],
  });
});

describe("cancellation and timeouts", () => {
  test("cancel: waiting nodes settle cancelled; a running one is cancelled whatever its action returns, never cached; dependents never start", async () => {
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
    const events: string[] = [];
    const results = await execute(g, ctx, {
      scheduler: throttledScheduler({ maxParallelism: 2 }),
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === "start") events.push(`start:${e.node}`);
        if (e.type === "result") events.push(`${e.result.status}:${e.node}`);
        // quick settles first; `after` is then ready, and the cancel lands before it starts.
        if (e.type === "result" && e.node === "quick") controller.abort();
      },
    });
    cancelling = false;
    const rerun = await execute(g, ctx);
    expect({
      ran: seen,
      statuses: statuses(results),
      keyed: results.filter((r) => r.actionKey !== "").map((r) => r.name),
      events,
      tally: tally(results),
      rerun: statuses(rerun),
    }).toEqual({
      ran: ["slow", "quick", "slow", "after", "never"],
      statuses: { quick: "done", after: "cancelled", slow: "cancelled", never: "cancelled" },
      keyed: ["quick", "slow"],
      events: [
        "start:slow",
        "start:quick",
        "done:quick",
        "cancelled:after",
        "cancelled:slow",
        "cancelled:never",
      ],
      tally: { done: 1, cached: 0, failed: 0, "dep-failed": 0, cancelled: 3 },
      rerun: { quick: "cached", slow: "done", after: "done", never: "done" },
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
      onEvent: (e) => e.type === "start" && setTimeout(() => controller.abort(), 5),
    });
    expect({
      ran,
      results: Object.fromEntries(results.map((r) => [r.name, [r.status, r.actionKey !== ""]])),
    }).toEqual({
      ran: ["holder"],
      results: { holder: ["cancelled", true], waiter: ["cancelled", true] },
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
    const summarize = (rs: Result[]) =>
      Object.fromEntries(
        rs.map((r) => [
          r.name,
          r.status === "failed" ? [r.status, r.error.name, r.error.message] : r.status,
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
        quick: "done",
        needs: "dep-failed",
        report: "done",
      },
      second: {
        hung: ["failed", "TimeoutError", "timed out after 20 ms"],
        quick: "cached",
        needs: "dep-failed",
        report: "cached",
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
    const { status, actionKey } = result;
    expect({ status, keyed: actionKey !== "", events }).toEqual({
      status: "cancelled",
      keyed: true,
      events: ["dispatch", "start", "cancelled"],
    });
  });

  test("a cancel that lands while the node's output directory is made holds the action back", async () => {
    const controller = new AbortController();
    const { ctx, fs } = setup();
    const slowMkdir: DagFs = {
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
