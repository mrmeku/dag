import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { FsCache, MemCache, TieredCache, type Cache, type DagFs } from "./cache.ts";
import { defineAction } from "./define-action.ts";
import { execute } from "./execute.ts";
import {
  file,
  Graph,
  settled,
  type ActionContext,
  type BaseParams,
  type NodeRef,
  type OutputRef,
  type SettledRef,
} from "./graph/index.ts";
import { createBunDagFs } from "./ports/fs.ts";
import { createMemoryDagFs, type MemoryDagFs } from "./ports/memory-fs.ts";
import { createNodeDagFs } from "./ports/node-fs.ts";
import { throttledScheduler } from "./schedulers.ts";
import { tally, type ExecEvent, type Result } from "./types.ts";

interface Ports {
  fs: DagFs;
}

async function write(c: { outputDir: string; ports: Ports }, name: string, content: string) {
  const path = `${c.outputDir}/${name}`;
  await c.ports.fs.writeText(path, content);
  return path;
}

interface TaskOptions {
  deps?: Record<string, NodeRef | SettledRef>;
  inputs?: Record<string, unknown>;
  /** What the node writes, or throws; by default its resolved inputs as JSON. */
  run?: (c: ActionContext<Ports>) => Promise<string | undefined> | string | undefined;
  cacheable?: boolean;
  concurrencyGroup?: string;
  timeoutMs?: number;
}

/** A node that writes one file. Its name is also an input, `id`, so no two nodes share a key. */
function task(g: Graph<Ports, any>, name: string, opts: TaskOptions = {}): NodeRef<string> {
  const { deps = {}, inputs, run, ...howToRun } = opts;
  return defineAction<Ports, BaseParams, string>({
    kind: "task",
    ...howToRun,
    action: async (c) => write(c, "out", (await run?.(c)) ?? JSON.stringify(c.inputs)),
  }).addNode(g, { name, deps, inputs: { id: name, ...inputs } });
}

function setup(cacheOf: (fs: MemoryDagFs) => Cache = () => new MemCache()) {
  const fs = createMemoryDagFs();
  const cache = cacheOf(fs);
  return { fs, cache, ctx: { ports: { fs }, cache, fs, casBaseDir: "/cas" } };
}

const statuses = (rs: Result[]) => Object.fromEntries(rs.map((r) => [r.name, r.status]));
const counts = (rs: Result[]) => ({ ran: tally(rs).done, hit: tally(rs).cached });
const outputsOf = (r: Result | undefined) =>
  r?.status === "done" || r?.status === "cached" ? (r.outputs as string) : "";

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

  test("tiered cache: a remote hit fills the local cache", async () => {
    const { ctx } = setup();
    const local = new MemCache();
    const tiered = { ...ctx, cache: new TieredCache({ local, remote: ctx.cache }) };
    expect({
      remote: counts(await execute(buildItems(["aaa"]), ctx)),
      tiered: counts(await execute(buildItems(["aaa"]), tiered)),
      local: counts(await execute(buildItems(["aaa"]), { ...ctx, cache: local })),
    }).toEqual({
      remote: { ran: 8, hit: 0 },
      tiered: { ran: 0, hit: 8 },
      local: { ran: 0, hit: 8 },
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

  test("force runs every node, and writes their new entries", async () => {
    const { ctx } = setup();
    const build = () => {
      const g = new Graph<Ports>();
      const a = task(g, "a");
      task(g, "b", { deps: { a } });
      return g;
    };
    expect([
      counts(await execute(build(), ctx)),
      counts(await execute(build(), ctx, { force: true })),
      counts(await execute(build(), ctx)),
    ]).toEqual([
      { ran: 2, hit: 0 },
      { ran: 2, hit: 0 },
      { ran: 0, hit: 2 },
    ]);
  });
});

describe("the action key", () => {
  test("inputs and deps alone identify an action: not its kind, function or how-to-run fields, nor the node's name or meta", async () => {
    const { ctx, fs } = setup();
    const make = (kind: string, content: string, group?: string) =>
      defineAction<Ports, BaseParams, string>({
        kind,
        inputs: { version: 1 },
        ...(group && { concurrencyGroup: group, timeoutMs: 1000 }),
        action: async (c) => write(c, "out", content),
      });
    const first = new Graph<Ports, { video: string }>();
    make("one", "made by one").addNode(first, { name: "a", meta: { video: "x" } });
    const second = new Graph<Ports, { video: string }>();
    make("two", "made by two", "heavy").addNode(second.subgraph("v", { video: "y" }), {
      name: "b",
    });
    const [one] = await execute(first, ctx);
    const [two] = await execute(second, ctx);
    expect({
      one: one!.status,
      two: [two!.name, two!.status, two!.actionKey === one!.actionKey],
      read: await fs.readText(outputsOf(two)),
    }).toEqual({ one: "done", two: ["v:b", "cached", true], read: "made by one" });
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
    const run = async (inputs: Record<string, unknown>) => {
      const g = new Graph<Ports>();
      task(g, "n", { inputs });
      const [r] = await execute(g, ctx);
      return [r!.status, await fs.readText(outputsOf(r))];
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

  test("a file input keys on its path and content, reads as its path, and is hashed once per execution", async () => {
    const { ctx, fs } = setup();
    const hashed: string[] = [];
    const counting = {
      ...ctx,
      fs: { ...fs, hashFile: (p: string) => (hashed.push(p), fs.hashFile(p)) },
    };
    await fs.writeText("/src/a.ts", "a1");
    const run = async (src: unknown) => {
      const g = new Graph<Ports>();
      for (const name of ["one", "two", "three"]) task(g, name, { inputs: { src } });
      const results = await execute(g, counting);
      return [statuses(results), await fs.readText(outputsOf(results[0]))];
    };
    const first = await run(file("/src/a.ts"));
    const firstHashed = hashed.filter((p) => p === "/src/a.ts").length;
    const same = await run(file("/src/a.ts"));
    await fs.writeText("/src/a.ts", "a2");
    const edited = await run(file("/src/a.ts"));
    const asValue = await run("/src/a.ts");
    const ran = { one: "done", two: "done", three: "done" } as const;
    expect({ first, firstHashed, same, edited, asValue }).toEqual({
      first: [ran, '{"id":"one","src":"/src/a.ts"}'],
      firstHashed: 1,
      same: [{ one: "cached", two: "cached", three: "cached" }, '{"id":"one","src":"/src/a.ts"}'],
      edited: [ran, '{"id":"one","src":"/src/a.ts"}'],
      asValue: [ran, '{"id":"one","src":"/src/a.ts"}'],
    });
  });

  test("an output ref reads as the dep's published path and keys by role and output name, so an invalidateOn fingerprint still holds", async () => {
    const { ctx, fs } = setup();
    type Packed = { tarball: string; notes: string };
    const pack = defineAction<Ports, { inputs: { version: string } }, Packed>({
      kind: "pack",
      action: async (c) => ({
        tarball: await write(c, "pkg.tgz", `pkg ${c.inputs.version}`),
        notes: await write(c, "notes.md", "notes"),
      }),
    });
    const publish = defineAction<Ports, { deps: { pack: NodeRef<Packed> } }, string>({
      kind: "publish",
      invalidateOn: { pack: (outputs, ports) => ports.fs.readText(outputs.notes) },
      action: async (c) => write(c, "cmd.json", JSON.stringify(c.inputs["cmd"])),
    });
    const run = async (version: string) => {
      const g = new Graph<Ports>();
      const p = pack.addNode(g, { inputs: { version } });
      publish.addNode(g, {
        deps: { pack: p },
        inputs: { cmd: ["npm", "publish", p.outputs.tarball] },
      });
      const results = await execute(g, ctx);
      const [packed, published] = results as [Result & { outputs: Packed }, Result];
      return {
        statuses: statuses(results),
        reads:
          (await fs.readText(outputsOf(published))) ===
          JSON.stringify(["npm", "publish", packed.outputs.tarball]),
      };
    };
    expect([await run("1.0"), await run("1.1")]).toEqual([
      { statuses: { pack: "done", publish: "done" }, reads: true },
      { statuses: { pack: "done", publish: "cached" }, reads: false },
    ]);
  });
});

describe("refs and outputs in the key", () => {
  type Pair = { main: string; extra: string };
  const pair = defineAction<Ports, BaseParams, Pair>({
    kind: "pair",
    inputs: { version: 1 },
    action: async (c) => ({
      main: await write(c, "m", "same"),
      extra: await write(c, "e", "same"),
    }),
  });
  const keyOfUse = async (
    ctx: ReturnType<typeof setup>["ctx"],
    names: [string, string],
    deps: (p: NodeRef<Pair>, q: NodeRef<Pair>) => Record<string, NodeRef>,
    ref: (p: NodeRef<Pair>, q: NodeRef<Pair>) => OutputRef,
  ) => {
    // p and q share one declaration, so one entry: they differ in name and role only.
    const g = new Graph<Ports>();
    const p = pair.addNode(g, { name: names[0] });
    const q = pair.addNode(g, { name: names[1] });
    task(g, "use", { deps: deps(p, q), inputs: { file: ref(p, q) } });
    return (await execute(g, ctx)).find((r) => r.name === "use")!.actionKey;
  };

  test("an output ref keys by the role it points through and its output's name, never by its node's name or by the output name alone", async () => {
    const { ctx } = setup();
    const roles = (p: NodeRef<Pair>, q: NodeRef<Pair>) => ({ left: p, right: q });
    const leftMain = await keyOfUse(ctx, ["p", "q"], roles, (p) => p.outputs.main);
    expect({
      renamed: (await keyOfUse(ctx, ["x", "y"], roles, (p) => p.outputs.main)) === leftMain,
      otherOutput: (await keyOfUse(ctx, ["p", "q"], roles, (p) => p.outputs.extra)) === leftMain,
      otherRole: (await keyOfUse(ctx, ["p", "q"], roles, (_, q) => q.outputs.main)) === leftMain,
    }).toEqual({ renamed: true, otherOutput: false, otherRole: false });
  });

  test("a ref to a node two roles name keys by all its roles, in sorted order", async () => {
    const { ctx } = setup();
    const main = (p: NodeRef<Pair>) => p.outputs.main;
    const both = await keyOfUse(ctx, ["p", "q"], (p) => ({ main: p, alias: p }), main);
    expect({
      reordered: (await keyOfUse(ctx, ["p", "q"], (p) => ({ alias: p, main: p }), main)) === both,
      oneRole: (await keyOfUse(ctx, ["p", "q"], (p, q) => ({ main: p, alias: q }), main)) === both,
    }).toEqual({ reordered: true, oneRole: false });
  });

  test("a content hash covers each output's name, each file's path in its output dir and its content, wherever the dir sits", async () => {
    const { ctx } = setup();
    const hashOf = async (version: number, files: Record<string, [string, string]>) => {
      const g = new Graph<Ports>();
      defineAction<Ports, BaseParams, Record<string, string>>({
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
      return (r as Result & { contentHash: string }).contentHash;
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

  test("an input file that cannot be read, or a fingerprint that throws, fails the node before it gets a key", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    const unreadable = task(g, "unreadable", { inputs: { src: file("/missing.ts") } });
    task(g, "after", { deps: { unreadable } });
    const src = task(g, "src");
    defineAction<Ports, { deps: { src: NodeRef<string> } }, string>({
      kind: "fingerprinted",
      invalidateOn: {
        src: () => {
          throw new Error("cannot fingerprint");
        },
      },
      action: async (c) => write(c, "out", "x"),
    }).addNode(g, { deps: { src } });
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
      src: "done",
      fingerprinted: ["failed", "", "cannot fingerprint"],
    });
  });
});

describe("the CAS", () => {
  test("an action writes into a private dir, renamed to {key}/out-{contentHash} beside the manifest when it succeeds, so an output named manifest.json still caches, and removed when it fails", async () => {
    const { ctx, fs } = setup((fs) => new FsCache("/cas", fs));
    const seen: string[] = [];
    const build = () => {
      const g = new Graph<Ports>();
      defineAction<Ports, BaseParams, string>({
        kind: "m",
        action: async (c) => {
          seen.push(c.outputDir);
          return write(c, "manifest.json", "an output, not the cache entry");
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
    const m = (await execute(build(), ctx)).find((r) => r.name === "m") as Result & {
      contentHash: string;
    };
    const second = await execute(build(), ctx);
    const dir = `/cas/${m.actionKey}`;
    expect({
      outputDir: seen[0]!.replace(/[0-9a-f-]{36}$/, "<uuid>"),
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

  test("a returned path outside the output dir fails the node", async () => {
    const { ctx } = setup();
    const g = new Graph<Ports>();
    const returning = (name: string, path: (c: ActionContext<Ports>) => Promise<string>) =>
      defineAction<Ports, BaseParams, string>({ kind: name, action: path }).addNode(g, {
        inputs: { id: name },
      });
    returning("escapes", (c) => write(c, "../sibling", "x"));
    returning(
      "elsewhere",
      async (c) => (await c.ports.fs.writeText("/elsewhere", "x"), "/elsewhere"),
    );
    const results = await execute(g, ctx);
    expect(
      Object.fromEntries(
        results.map((r) => [r.name, r.status === "failed" && r.error.message.split(":")[0]]),
      ),
    ).toEqual({
      escapes: "output not under the output dir",
      elsewhere: "output not under the output dir",
    });
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
    const old = { outputs: "/cas/k/out-1/f", contentHash: "1" };
    const next = { outputs: "/cas/k/out-2/f", contentHash: "2" };
    await new FsCache("/cas", base).put("k", old);
    const cache = new FsCache("/cas", fs);
    const putting = cache.put("k", next);
    await halfWritten.promise;
    const during = await cache.get("k");
    resume.resolve();
    await putting;
    expect({ during, after: await cache.get("k") }).toEqual({ during: old, after: next });
  });

  test("a key that re-executes to new content removes the dir its old entry named, a legacy {key}/out included", async () => {
    const { ctx, fs, cache } = setup((fs) => new FsCache("/cas", fs));
    let content = "one";
    const run = async (force: boolean) => {
      const g = new Graph<Ports>();
      task(g, "m", { run: () => content });
      return (await execute(g, ctx, { force }))[0] as Result & { contentHash: string };
    };
    const first = await run(false);
    const dir = `/cas/${first.actionKey}`;
    // The layout before out-{contentHash}: the entry names {key}/out.
    await fs.remove(`${dir}/out-${first.contentHash}`);
    await fs.writeText(`${dir}/out/out`, "one");
    await cache.put(first.actionKey, { outputs: `${dir}/out/out`, contentHash: first.contentHash });
    content = "two";
    await run(true);
    content = "three";
    const last = await run(true);
    expect([...fs.files.keys()].sort()).toEqual([
      `${dir}/manifest.json`,
      `${dir}/out-${last.contentHash}/out`,
    ]);
  });

  test("attempts of one key at once never remove each other's files, and the key's next attempt keeps only its own", async () => {
    const { ctx, fs, cache } = setup((fs) => new FsCache("/cas", fs));
    let calls = 0;
    const chapters = defineAction<Ports, BaseParams, string>({
      kind: "chapters",
      inputs: { version: "chapters-v1" },
      action: async (c) => write(c, "chapters.json", "[]"),
    });
    const clean = defineAction<Ports, BaseParams, string>({
      kind: "clean_description",
      inputs: { version: "clean-v1", prompt: "clean" },
      action: async (c) => write(c, "description.txt", `call ${++calls}`),
    });
    const upload = defineAction<Ports, BaseParams, string>({
      kind: "upload",
      cacheable: false,
      inputs: { version: "upload-v1" },
      action: async (c) => write(c, "id.txt", `call ${++calls}`),
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
    const entry = await cache.get(first["v1:clean_description"]!.actionKey);
    const together = {
      statuses: Object.values(first).map((r) => r.status),
      chapters: new Set(both("chapters")).size,
      cleaned: await Promise.all(both("clean_description").map((p) => fs.exists(p))),
      entry: both("clean_description").includes(entry?.outputs as string),
      uploaded: await Promise.all(both("upload").map((p) => fs.exists(p))),
    };
    const next = by(await execute(build(["v1"]), ctx, { force: true }));
    const dirsOf = async (node: string) => {
      const r = next[`v1:${node}`] as Result & { contentHash: string };
      const dirs = (await fs.readdir(`/cas/${r.actionKey}`)).sort();
      return dirs.map((d) => (d === `out-${r.contentHash}` ? "out-<its own>" : d));
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
      clean: ["manifest.json", "out-<its own>"],
      upload: ["out-<its own>"],
    });
  });

  test("a casBaseDir with a trailing slash is the same directory", async () => {
    const { ctx } = setup();
    const run = async (casBaseDir: string) => {
      const g = new Graph<Ports>();
      task(g, "a");
      const [r] = await execute(g, { ...ctx, casBaseDir });
      return [r!.status, outputsOf(r).startsWith(`/cas/${r!.actionKey}/out-`)];
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
    expect([r!.status, (await memory.get(r!.actionKey))?.outputs === outputsOf(r)]).toEqual([
      "done",
      true,
    ]);
  });

  test("under a relative casBaseDir, an output built with path.join follows its dir when it moves, and one resolved to an absolute path fails the node", async () => {
    const fs = createNodeDagFs();
    const tmp = await mkdtemp(join(tmpdir(), "dagraph-"));
    const casBaseDir = `./${relative(process.cwd(), tmp)}/cas`;
    const c = { ports: { fs }, cache: new FsCache(casBaseDir, fs), fs, casBaseDir };
    const build = () => {
      const g = new Graph<Ports>();
      const joined = defineAction<Ports, BaseParams, string>({
        kind: "joined",
        action: async (c) => {
          const path = join(c.outputDir, "srt");
          await c.ports.fs.writeText(path, "subtitles");
          return path;
        },
      }).addNode(g, { inputs: { id: "joined" } });
      task(g, "reader", {
        deps: { joined },
        run: (c) => fs.readText(c.depOutputs["joined"] as string),
      });
      defineAction<Ports, BaseParams, string>({
        kind: "absolute",
        action: async (c) => {
          const path = resolve(c.outputDir, "a");
          await c.ports.fs.writeText(path, "a");
          return path;
        },
      }).addNode(g, { inputs: { id: "absolute" } });
      return g;
    };
    const status = (rs: Result[]) =>
      Object.fromEntries(
        rs.map((r) => [r.name, r.status === "failed" ? r.error.message.split(":")[0] : r.status]),
      );
    const first = status(await execute(build(), c));
    const second = status(await execute(build(), c));
    await rm(tmp, { recursive: true, force: true });
    expect({ first, second }).toEqual({
      first: { joined: "done", reader: "done", absolute: "output not under the output dir" },
      second: { joined: "cached", reader: "cached", absolute: "output not under the output dir" },
    });
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
            const n = Number(await c.ports.fs.readText(c.depOutputs["count"] as string));
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
    const probe = second.find((r) => r.name === "probe")!;
    expect({
      second: statuses(second),
      stored: await cache.get(probe.actionKey),
    }).toEqual({ second: { probe: "done", report: "cached" }, stored: undefined });
  });

  test("keeps only the output dir of its latest attempt, a legacy {key}/out included", async () => {
    const { ctx, fs } = setup((fs) => new FsCache("/cas", fs));
    let content = "one";
    const run = async () => {
      const g = new Graph<Ports>();
      task(g, "upload", { cacheable: false, run: () => content });
      return (await execute(g, ctx))[0] as Result & { contentHash: string };
    };
    const first = await run();
    const dir = `/cas/${first.actionKey}`;
    await fs.writeText(`${dir}/out/id.json`, "legacy");
    content = "two";
    await run();
    content = "three";
    const last = await run();
    expect([...fs.files.keys()].sort()).toEqual([`${dir}/out-${last.contentHash}/out`]);
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
    const events: unknown[] = [];
    let slowWhenFastSettled: unknown[] = [];
    await execute(build(true), ctx, {
      onEvent: (e: ExecEvent<{ video: string }>) => {
        const detail = e.type === "output" ? e.chunk : e.type === "result" ? e.result.status : "";
        events.push([e.type, e.node, e.meta?.video ?? "", detail]);
        if (e.type === "result" && e.node === "v1:fast") {
          slowWhenFastSettled = events.filter((ev) => (ev as string[])[1] === "slow");
          releaseSlow.resolve();
        }
      },
    });
    await late.promise;
    const of = (node: string) => events.filter((e) => (e as string[])[1] === node);
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

describe("verify outputs on a cache hit", () => {
  test("a deleted or changed output re-runs the node", async () => {
    const { ctx, fs } = setup();
    const run = async () => {
      const g = new Graph<Ports>();
      task(g, "a", { run: () => "original" });
      const [r] = await execute(g, ctx);
      return r!;
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
      return [r!.status, outputsOf(r)];
    };
    const [, path] = await run();
    await fs.writeText(path!, "x");
    const second = await run();
    const third = await run();
    expect({ second, third, content: await fs.readText(`${seen[1]}/out`) }).toEqual({
      second: ["done", `${seen[1]}/out`],
      third: ["cached", `${seen[1]}/out`],
      content: "original",
    });
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
  const captions = defineAction<Ports, BaseParams, { srt: string }>({
    kind: "captions",
    action: async (c) => {
      if (!ready) throw new Error("not ready");
      return { srt: await write(c, "captions.srt", "hello") };
    },
  });
  const entry = defineAction<Ports, { deps: { captions: SettledRef<{ srt: string }> } }, string>({
    kind: "entry",
    action: async (c) => {
      received.push([
        c.depOutputs.captions === undefined,
        c.inputs["srt"] === c.depOutputs.captions?.srt,
      ]);
      return write(c, "entry.txt", "entry");
    },
  });
  const run = async () => {
    const g = new Graph<Ports>();
    const ref = captions.addNode(g, {});
    entry.addNode(g, {
      deps: { captions: settled(ref) },
      inputs: { srt: settled(ref).outputs.srt },
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
  const both = defineAction<
    Ports,
    { deps: { main: NodeRef<string>; after: SettledRef<string> } },
    string
  >({
    kind: "both",
    action: async (c) => {
      runs.push(c.depOutputs.main === c.depOutputs.after);
      return write(c, "both.txt", "both");
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
              reasons.push((c.signal.reason as Error).name);
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
    expect({ status: result!.status, keyed: result!.actionKey !== "", events }).toEqual({
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
    expect({ ran, status: result!.status, files: [...fs.files.keys()] }).toEqual({
      ran: false,
      status: "cancelled",
      files: [],
    });
  });
});
