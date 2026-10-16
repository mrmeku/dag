import { describe, expect, test } from "bun:test";

import type { DagFs } from "./cache.ts";
import { MemCache, TieredCache } from "./cache.ts";
import { defineAction } from "./define-action.ts";
import type { ExecResult } from "./exec-state.ts";
import type { ExecutionContext } from "./execute.ts";
import { execute } from "./execute.ts";
import {
  Graph,
  optional,
  validateNoCycles,
  type BaseParams,
  type NodeRef,
  type OptionalRef,
  type RunnableNode,
} from "./graph/index.ts";
import { createMemoryDagFs } from "./ports/memory-fs.ts";
import { throttledScheduler } from "./schedulers.ts";
import { tally, type ExecEvent } from "./types.ts";

async function write(fs: DagFs, name: string, content: string): Promise<string> {
  await fs.writeText(name, content);
  return name;
}

function countExec(results: ExecResult[]): { exec: number; skip: number } {
  const t = tally(results);
  return { exec: t.done, skip: t.cached };
}
const p = (kind: string, deps?: Record<string, string>): BaseParams =>
  deps
    ? {
        kind,
        deps: Object.fromEntries(Object.entries(deps).map(([k, v]) => [k, { name: v }])),
      }
    : { kind };

function addItemNodes(g: Graph, id: string, fs: DagFs): void {
  const sg = g.subgraph(id);
  const n = (kind: string) => `${id}:${kind}`;
  sg.add({
    name: "fetch",
    kind: "fetch",
    deps: [],
    config: id,
    params: p("fetch"),
    action: async () => write(fs, `${id}-fetch.json`, `{"id":"${id}"}`),
  });
  sg.add({
    name: "extract",
    kind: "extract",
    deps: [n("fetch")],
    config: "extract-v1",
    params: p("extract", { fetch: n("fetch") }),
    action: async () => write(fs, `${id}-raw.bin`, `raw-${id}`),
  });
  sg.add({
    name: "parse",
    kind: "parse",
    deps: [n("extract")],
    config: "parse-v1",
    params: p("parse", { extract: n("extract") }),
    action: async () => write(fs, `${id}-parsed.txt`, `Parsed ${id}`),
  });
  sg.add({
    name: "summarize",
    kind: "summarize",
    deps: [n("parse")],
    config: "summarize-v2",
    params: p("summarize", { parse: n("parse") }),
    action: async () => write(fs, `${id}-summary.txt`, `Summary of ${id}`),
  });
  sg.add({
    name: "classify",
    kind: "classify",
    deps: [n("parse")],
    config: "classify-v1",
    params: p("classify", { parse: n("parse") }),
    action: async () => write(fs, `${id}-classify.json`, `["tag_a","tag_b"]`),
  });
  sg.add({
    name: "resize",
    kind: "resize",
    deps: [n("fetch")],
    config: "resize-v1",
    params: p("resize", { fetch: n("fetch") }),
    action: async () => write(fs, `${id}-thumb.jpg`, `thumb-${id}`),
  });
  sg.add({
    name: "entry",
    kind: "entry",
    deps: [n("summarize"), n("classify"), n("extract"), n("resize")],
    config: "entry-v1",
    params: p("entry", {
      summarize: n("summarize"),
      classify: n("classify"),
      extract: n("extract"),
      resize: n("resize"),
    }),
    action: async () => write(fs, `${id}-entry.json`, `{"entry":"${id}"}`),
  });
}

function addAggregateNode(g: Graph, ids: string[], fs: DagFs): void {
  const deps = ids.map((id) => `${id}:entry`);
  const depsRecord = Object.fromEntries(deps.map((d) => [d, d]));
  g.add({
    name: "aggregate",
    kind: "aggregate",
    deps,
    config: "aggregate-v1",
    params: p("aggregate", depsRecord),
    action: async () => write(fs, "aggregate.json", `[${ids.join(",")}]`),
  });
}

function buildGraph(ids: string[], fs: DagFs): Graph {
  const g = new Graph();
  for (const id of ids) addItemNodes(g, id, fs);
  addAggregateNode(g, ids, fs);
  return g;
}

function ctx(cache: MemCache | TieredCache, fs: DagFs): ExecutionContext {
  return { cache, fs, casBaseDir: "/cas" };
}

describe("Graph", () => {
  test("incremental items", async () => {
    const fs = createMemoryDagFs();
    const cache = new MemCache();

    let results = await execute(buildGraph(["aaa", "bbb"], fs), ctx(cache, fs));
    let { exec, skip } = countExec(results);
    expect(skip).toBe(0);
    expect(exec).toBe(15);

    results = await execute(buildGraph(["aaa", "bbb"], fs), ctx(cache, fs));
    ({ exec, skip } = countExec(results));
    expect(exec).toBe(0);
    expect(skip).toBe(15);

    results = await execute(buildGraph(["aaa", "bbb", "ccc"], fs), ctx(cache, fs));
    ({ exec, skip } = countExec(results));
    expect(exec).toBe(8);
    expect(skip).toBe(14);
  });

  test("tiered cache", async () => {
    const fs = createMemoryDagFs();
    const remote = new MemCache();

    let results = await execute(buildGraph(["aaa"], fs), ctx(remote, fs));
    let { exec } = countExec(results);
    expect(exec).toBe(8);

    const local = new MemCache();
    const tiered = new TieredCache({ local, remote });
    results = await execute(buildGraph(["aaa"], fs), ctx(tiered, fs));
    ({ exec } = countExec(results));
    expect(exec).toBe(0);

    results = await execute(buildGraph(["aaa"], fs), ctx(local, fs));
    ({ exec } = countExec(results));
    expect(exec).toBe(0);
  });

  describe("analyze()", () => {
    test("returns total count", () => {
      const fs = createMemoryDagFs();
      const { total } = buildGraph(["aaa", "bbb"], fs).analyze();
      expect(total).toBe(15);
    });

    test("byKind breakdown", () => {
      const fs = createMemoryDagFs();
      const { byKind } = buildGraph(["aaa", "bbb"], fs).analyze();
      expect(Object.fromEntries(byKind)).toEqual({
        fetch: 2,
        extract: 2,
        parse: 2,
        summarize: 2,
        classify: 2,
        resize: 2,
        entry: 2,
        aggregate: 1,
      });
    });

    test("nodes list", () => {
      const fs = createMemoryDagFs();
      const { nodes } = buildGraph(["aaa"], fs).analyze();
      expect(nodes.length).toBe(8);
      const fetchNode = nodes.find((n) => n.name === "aaa:fetch")!;
      expect(fetchNode.kind).toBe("fetch");
      expect(fetchNode.deps).toEqual([]);
    });
  });

  test("readiness: dependent starts as soon as its deps finish", async () => {
    const fs = createMemoryDagFs();
    const cache = new MemCache();
    const g = new Graph();
    const log: string[] = [];

    g.add({
      name: "slow_root",
      kind: "root",
      deps: [],
      config: "a",
      params: p("root"),
      action: async () => {
        await Bun.sleep(50);
        log.push("slow_root");
        return write(fs, "slow_root.txt", "a");
      },
    });
    g.add({
      name: "fast_root",
      kind: "root",
      deps: [],
      config: "b",
      params: p("root"),
      action: async () => {
        log.push("fast_root");
        return write(fs, "fast_root.txt", "b");
      },
    });
    g.add({
      name: "slow_child",
      kind: "child",
      deps: ["slow_root"],
      config: "c",
      params: p("child", { slow_root: "slow_root" }),
      action: async () => {
        log.push("slow_child");
        return write(fs, "slow_child.txt", "c");
      },
    });
    g.add({
      name: "fast_child",
      kind: "child",
      deps: ["fast_root"],
      config: "d",
      params: p("child", { fast_root: "fast_root" }),
      action: async () => {
        log.push("fast_child");
        return write(fs, "fast_child.txt", "d");
      },
    });

    await execute(g, ctx(cache, fs));
    expect(log).toEqual(["fast_root", "fast_child", "slow_root", "slow_child"]);
  });

  test("children of completed nodes run before queued siblings", async () => {
    const fs = createMemoryDagFs();
    const cache = new MemCache();
    const g = new Graph();
    const log: string[] = [];

    g.add({
      name: "first_root",
      kind: "root",
      deps: [],
      config: "r1",
      params: p("root"),
      action: async () => {
        log.push("first_root");
        return write(fs, "r1.txt", "r1");
      },
    });
    g.add({
      name: "second_root",
      kind: "root",
      deps: [],
      config: "r2",
      params: p("root"),
      action: async () => {
        log.push("second_root");
        return write(fs, "r2.txt", "r2");
      },
    });
    g.add({
      name: "child",
      kind: "child",
      deps: ["first_root"],
      config: "c1",
      params: p("child", { first_root: "first_root" }),
      action: async () => {
        log.push("child");
        return write(fs, "c1.txt", "c1");
      },
    });

    await execute(g, ctx(cache, fs), { scheduler: throttledScheduler({ maxParallelism: 1 }) });
    expect(log).toEqual(["first_root", "child", "second_root"]);
  });

  test("contended group slots go to the earliest-added root's work, not the latest-ready", async () => {
    const fs = createMemoryDagFs();
    const cache = new MemCache();
    const g = new Graph();
    const heavyOrder: string[] = [];
    const rootDelays = { a: 20, b: 0, c: 40 };

    for (const [id, delay] of Object.entries(rootDelays)) {
      g.add({
        name: `${id}_root`,
        kind: "root",
        deps: [],
        config: id,
        params: p("root"),
        action: async () => {
          await Bun.sleep(delay);
          return write(fs, `${id}_root.txt`, id);
        },
      });
    }
    for (const id of Object.keys(rootDelays)) {
      g.add({
        name: `${id}_heavy`,
        kind: "heavy",
        deps: [`${id}_root`],
        config: id,
        concurrencyGroup: "heavy",
        params: p("heavy", { root: `${id}_root` }),
        action: async () => {
          heavyOrder.push(id);
          await Bun.sleep(id === "b" ? 80 : 0);
          return write(fs, `${id}_heavy.txt`, id);
        },
      });
    }

    await execute(g, ctx(cache, fs), {
      scheduler: throttledScheduler({ concurrencyLimits: { heavy: 1 } }),
    });
    expect(heavyOrder).toEqual(["b", "a", "c"]);
  });

  test("config change rollback", async () => {
    const fs = createMemoryDagFs();
    const cache = new MemCache();
    let leafConfig = "leaf-v2";

    const makeGraph = () => {
      const g = new Graph();
      g.add({
        name: "fetch",
        kind: "fetch",
        deps: [],
        config: "fetch-v1",
        params: p("fetch"),
        action: async () => write(fs, "fetch.json", '{"id":"aaa"}'),
      });
      g.add({
        name: "extract",
        kind: "extract",
        deps: ["fetch"],
        config: "extract-v1",
        params: p("extract", { fetch: "fetch" }),
        action: async () => write(fs, "raw.bin", "raw"),
      });
      g.add({
        name: "parse",
        kind: "parse",
        deps: ["extract"],
        config: "parse-v1",
        params: p("parse", { extract: "extract" }),
        action: async () => write(fs, "parsed.txt", "parsed"),
      });
      g.add({
        name: "summarize",
        kind: "summarize",
        deps: ["parse"],
        config: leafConfig,
        params: p("summarize", { parse: "parse" }),
        action: async () => write(fs, "summary.txt", "summary"),
      });
      return g;
    };

    let results = await execute(makeGraph(), ctx(cache, fs));
    let { exec, skip } = countExec(results);
    expect(exec).toBe(4);
    expect(skip).toBe(0);

    leafConfig = "leaf-v3";
    results = await execute(makeGraph(), ctx(cache, fs));
    ({ exec, skip } = countExec(results));
    expect(exec).toBe(1);

    leafConfig = "leaf-v2";
    results = await execute(makeGraph(), ctx(cache, fs));
    ({ exec, skip } = countExec(results));
    expect(exec).toBe(0);
  });

  test("failure in one branch does not affect independent branches", async () => {
    const fs = createMemoryDagFs();
    const cache = new MemCache();
    const g = new Graph();
    g.add({
      name: "good_root",
      kind: "root",
      deps: [],
      config: "1",
      params: p("root"),
      action: async () => write(fs, "good_root.txt", "ok"),
    });
    g.add({
      name: "good_child",
      kind: "child",
      deps: ["good_root"],
      config: "2",
      params: p("child", { good_root: "good_root" }),
      action: async () => write(fs, "good_child.txt", "ok"),
    });
    g.add({
      name: "bad_root",
      kind: "root",
      deps: [],
      config: "3",
      params: p("root"),
      action: async () => {
        throw new Error("boom");
      },
    });
    g.add({
      name: "bad_child",
      kind: "child",
      deps: ["bad_root"],
      config: "4",
      params: p("child", { bad_root: "bad_root" }),
      action: async () => "unreachable",
    });

    const results = await execute(g, ctx(cache, fs));
    const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));
    expect(byName).toEqual({
      good_root: "done",
      good_child: "done",
      bad_root: "fail",
      bad_child: "dep-failed",
    });
  });

  test("dep-failure cascades through transitive dependencies", async () => {
    const fs = createMemoryDagFs();
    const cache = new MemCache();
    const g = new Graph();
    g.add({
      name: "a",
      kind: "root",
      deps: [],
      config: "1",
      params: p("root"),
      action: async () => {
        throw new Error("boom");
      },
    });
    g.add({
      name: "b",
      kind: "mid",
      deps: ["a"],
      config: "2",
      params: p("mid", { a: "a" }),
      action: async () => "unreachable",
    });
    g.add({
      name: "c",
      kind: "mid",
      deps: ["b"],
      config: "3",
      params: p("mid", { b: "b" }),
      action: async () => "unreachable",
    });
    g.add({
      name: "d",
      kind: "leaf",
      deps: ["c"],
      config: "4",
      params: p("leaf", { c: "c" }),
      action: async () => "unreachable",
    });

    const results = await execute(g, ctx(cache, fs));
    // The failed node ran, so its result keeps the action key of the CAS dir it wrote to;
    // skipped nodes never computed one.
    const byName = Object.fromEntries(
      results.map((r) => [
        r.name,
        { status: r.status, hasKey: /^[0-9a-f]{64}$/.test(r.actionKey) },
      ]),
    );
    expect(byName).toEqual({
      a: { status: "fail", hasKey: true },
      b: { status: "dep-failed", hasKey: false },
      c: { status: "dep-failed", hasKey: false },
      d: { status: "dep-failed", hasKey: false },
    });
  });

  test("maxParallelism caps concurrent execution", async () => {
    const fs = createMemoryDagFs();
    const cache = new MemCache();
    const g = new Graph();
    let peak = 0;
    let inflight = 0;

    for (let i = 0; i < 6; i++) {
      g.add({
        name: `task_${i}`,
        kind: "task",
        deps: [],
        config: `${i}`,
        params: p("task"),
        action: async () => {
          inflight++;
          peak = Math.max(peak, inflight);
          await Bun.sleep(20);
          inflight--;
          return write(fs, `task_${i}.txt`, `${i}`);
        },
      });
    }

    const results = await execute(g, ctx(cache, fs), {
      scheduler: throttledScheduler({ maxParallelism: 2 }),
    });
    expect(peak).toBe(2);
    expect(results.filter((r) => r.status === "done").length).toBe(6);
  });

  describe("inputs", () => {
    test("declared input files join the key: unchanged hits, edited re-runs", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      const makeGraph = () => {
        const g = new Graph();
        g.add({
          name: "check",
          kind: "check",
          deps: [],
          inputs: ["/src/b.ts", "/src/a.ts"],
          config: "v1",
          params: p("check"),
          action: async (_inputs, outputDir) => write(fs, `${outputDir}/ok`, "ok"),
        });
        return g;
      };
      await fs.writeText("/src/a.ts", "a1");
      await fs.writeText("/src/b.ts", "b1");

      const first = countExec(await execute(makeGraph(), ctx(cache, fs)));
      const same = countExec(await execute(makeGraph(), ctx(cache, fs)));
      await fs.writeText("/src/a.ts", "a2");
      const edited = countExec(await execute(makeGraph(), ctx(cache, fs)));
      expect({ first, same, edited }).toEqual({
        first: { exec: 1, skip: 0 },
        same: { exec: 0, skip: 1 },
        edited: { exec: 1, skip: 0 },
      });
    });
  });

  describe("output directory", () => {
    test("outputs live under {key}/out, so an output named manifest.json still caches", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      const seen: string[] = [];
      const makeGraph = () => {
        const g = new Graph();
        g.add({
          name: "m",
          kind: "m",
          deps: [],
          config: "v1",
          params: p("m"),
          action: async (_inputs, outputDir) => {
            seen.push(outputDir);
            return write(fs, `${outputDir}/manifest.json`, "an output, not the cache entry");
          },
        });
        return g;
      };

      const first = await execute(makeGraph(), ctx(cache, fs));
      const second = await execute(makeGraph(), ctx(cache, fs));
      const key = first[0]!.actionKey;
      expect({
        outputDir: seen[0],
        second: countExec(second),
        cacheEntryIntact: (await cache.get(key))?.outputs,
      }).toEqual({
        outputDir: `/cas/${key}/out`,
        second: { exec: 0, skip: 1 },
        cacheEntryIntact: `/cas/${key}/out/manifest.json`,
      });
    });
  });

  describe("cacheable: false", () => {
    test("runs every time, never stores an entry, and downstream still caches by content", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      const makeGraph = () => {
        const g = new Graph();
        g.add({
          name: "probe",
          kind: "probe",
          deps: [],
          config: "v1",
          cacheable: false,
          params: p("probe"),
          action: async () => write(fs, "probe.txt", "same-every-time"),
        });
        g.add({
          name: "report",
          kind: "report",
          deps: ["probe"],
          config: "v1",
          params: p("report", { probe: "probe" }),
          action: async () => write(fs, "report.txt", "report"),
        });
        return g;
      };

      await execute(makeGraph(), ctx(cache, fs));
      const second = await execute(makeGraph(), ctx(cache, fs));
      const probe = second.find((r) => r.name === "probe")!;
      expect({
        second: countExec(second),
        probe: probe.status,
        stored: await cache.get(probe.actionKey),
      }).toEqual({ second: { exec: 1, skip: 1 }, probe: "done", stored: undefined });
    });
  });

  describe("early cutoff", () => {
    test("same output content skips downstream", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      let aConfig = "a-v1";

      const makeGraph = () => {
        const g = new Graph();
        g.add({
          name: "a",
          kind: "root",
          deps: [],
          config: aConfig,
          params: p("root"),
          action: async () => write(fs, "a.txt", "stable-content"),
        });
        g.add({
          name: "b",
          kind: "child",
          deps: ["a"],
          config: "b-v1",
          params: p("child", { a: "a" }),
          action: async () => write(fs, "b.txt", "b-content"),
        });
        return g;
      };

      let results = await execute(makeGraph(), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 2, skip: 0 });

      aConfig = "a-v2";
      results = await execute(makeGraph(), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 1, skip: 1 });
    });

    test("different output content re-executes downstream", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      let aConfig = "a-v1";
      let aContent = "content-v1";

      const makeGraph = () => {
        const g = new Graph();
        g.add({
          name: "a",
          kind: "root",
          deps: [],
          config: aConfig,
          params: p("root"),
          action: async () => write(fs, "a.txt", aContent),
        });
        g.add({
          name: "b",
          kind: "child",
          deps: ["a"],
          config: "b-v1",
          params: p("child", { a: "a" }),
          action: async () => write(fs, "b.txt", "b-content"),
        });
        return g;
      };

      let results = await execute(makeGraph(), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 2, skip: 0 });

      aConfig = "a-v2";
      aContent = "content-v2";
      results = await execute(makeGraph(), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 2, skip: 0 });
    });

    test("cutoff chain: A → B → C, only A runs if output unchanged", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      let aConfig = "a-v1";

      const makeGraph = () => {
        const g = new Graph();
        g.add({
          name: "a",
          kind: "root",
          deps: [],
          config: aConfig,
          params: p("root"),
          action: async () => write(fs, "a.txt", "stable"),
        });
        g.add({
          name: "b",
          kind: "mid",
          deps: ["a"],
          config: "b-v1",
          params: p("mid", { a: "a" }),
          action: async () => write(fs, "b.txt", "b-stable"),
        });
        g.add({
          name: "c",
          kind: "leaf",
          deps: ["b"],
          config: "c-v1",
          params: p("leaf", { b: "b" }),
          action: async () => write(fs, "c.txt", "c-stable"),
        });
        return g;
      };

      let results = await execute(makeGraph(), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 3, skip: 0 });

      aConfig = "a-v2";
      results = await execute(makeGraph(), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 1, skip: 2 });
    });
  });

  describe("progress events", () => {
    test("each event marks its moment in a node's life: start after a cache miss and before the action, the result after it; start is live while other nodes run, and a cached or held node never starts", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      const lives: Record<string, string[]> = {};
      const mark = (name: string, moment: string) => (lives[name] ??= []).push(moment);
      let releaseSlow = () => {};
      const fastSettled = new Promise<void>((r) => (releaseSlow = r));
      let slowWhenFastSettled: string[] = [];
      const add = (g: Graph, name: string, run: () => Promise<unknown>, cacheable = true) =>
        g.add({
          name,
          kind: name,
          deps: [],
          config: "1",
          params: p(name),
          ...(!cacheable && { cacheable: false }),
          action: async () => {
            mark(name, "action begins");
            await run();
            mark(name, "action ends");
            return write(fs, `${name}.txt`, name);
          },
        });

      const first = new Graph();
      add(first, "warm", async () => {});
      await execute(first, ctx(cache, fs));
      delete lives["warm"];

      const g = new Graph();
      add(g, "warm", async () => {});
      add(g, "held", async () => {});
      add(g, "slow", () => fastSettled, false);
      add(g, "fast", async () => {}, false);
      await execute(g, ctx(cache, fs), {
        cacheOnly: (n) => n.name === "held",
        onEvent: (ev) => {
          mark(ev.node.name, ev.type);
          if (ev.type === "settled" && ev.node.name === "fast") {
            slowWhenFastSettled = [...lives["slow"]!];
            releaseSlow();
          }
        },
      });

      const ran = ["dispatch", "start", "action begins", "action ends", "done", "settled"];
      expect({ lives, slowWhenFastSettled }).toEqual({
        lives: {
          warm: ["dispatch", "cached", "settled"],
          held: ["dispatch", "fail", "settled"],
          slow: ran,
          fast: ran,
        },
        slowWhenFastSettled: ["dispatch", "start", "action begins"],
      });
    });

    test("emits start+success for dirty nodes", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      const g = new Graph();
      g.add({
        name: "a",
        kind: "root",
        deps: [],
        config: "1",
        params: p("root"),
        action: async () => write(fs, "a.txt", "a"),
      });
      g.add({
        name: "b",
        kind: "child",
        deps: ["a"],
        config: "2",
        params: p("child", { a: "a" }),
        action: async () => write(fs, "b.txt", "b"),
      });

      const actions: ExecEvent[] = [];
      await execute(g, ctx(cache, fs), {
        scheduler: throttledScheduler({ maxParallelism: 1 }),
        onEvent: (a) => actions.push(a),
      });

      const types = actions.map((a) => `${a.type}:${a.node.name}`);
      expect(types).toEqual([
        "dispatch:a",
        "start:a",
        "done:a",
        "settled:a",
        "dispatch:b",
        "start:b",
        "done:b",
        "settled:b",
      ]);
      for (const a of actions) {
        if (a.type === "done") expect(a.elapsed).toBeGreaterThanOrEqual(0);
      }
    });

    test("emits cache-hit for cached nodes", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      const makeGraph = () => {
        const g = new Graph();
        g.add({
          name: "a",
          kind: "root",
          deps: [],
          config: "1",
          params: p("root"),
          action: async () => write(fs, "a.txt", "a"),
        });
        g.add({
          name: "b",
          kind: "child",
          deps: ["a"],
          config: "2",
          params: p("child", { a: "a" }),
          action: async () => write(fs, "b.txt", "b"),
        });
        return g;
      };

      await execute(makeGraph(), ctx(cache, fs));

      const actions: ExecEvent[] = [];
      await execute(makeGraph(), ctx(cache, fs), {
        onEvent: (a) => actions.push(a),
      });

      const types = actions.map((a) => `${a.type}:${a.node.name}`);
      expect(types).toEqual([
        "dispatch:a",
        "cached:a",
        "settled:a",
        "dispatch:b",
        "cached:b",
        "settled:b",
      ]);
    });

    test("emits start+failure on error with elapsed", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      const g = new Graph();
      g.add({
        name: "bad",
        kind: "task",
        deps: [],
        config: "1",
        params: p("task"),
        action: async () => {
          throw new Error("boom");
        },
      });

      const actions: ExecEvent[] = [];
      await execute(g, ctx(cache, fs), { onEvent: (a) => actions.push(a) });

      const types = actions.map((a) => `${a.type}:${a.node.name}`);
      expect(types).toEqual(["dispatch:bad", "start:bad", "fail:bad", "settled:bad"]);
      const fail = actions.find((a) => a.type === "fail")!;
      if (fail.type === "fail") {
        expect(fail.error).toBeInstanceOf(Error);
        expect((fail.error as Error).message).toBe("boom");
        expect(fail.elapsed).toBeGreaterThanOrEqual(0);
      }
    });

    test("what an action prints reaches onOutput with its node as it prints it, and a failure keeps its error's cause, a timeout's too", async () => {
      const g = new Graph();
      for (const [name, timeoutMs] of [["bad"], ["slow", 5]] as const)
        g.add({
          name,
          kind: "task",
          deps: [],
          config: "1",
          ...(timeoutMs && { timeoutMs }),
          params: p("task"),
          action: async (_inputs, _out, { output, signal } = {}) => {
            output?.(`${name} ran\n`);
            if (timeoutMs) await new Promise((r) => signal!.addEventListener("abort", r));
            throw new Error(`${name} exited 1`, { cause: { argv: [name], code: 1 } });
          },
        });
      const seen: unknown[] = [];
      await execute(g, ctx(new MemCache(), createMemoryDagFs()), {
        scheduler: throttledScheduler({ maxParallelism: 1 }),
        onOutput: (node, chunk) => seen.push([node.name, chunk]),
        onEvent: (e) => {
          if (e.type === "fail")
            seen.push([e.node.name, (e.error as Error).name, (e.error as Error).cause]);
        },
      });
      expect(seen).toEqual([
        ["bad", "bad ran\n"],
        ["bad", "Error", { argv: ["bad"], code: 1 }],
        ["slow", "slow ran\n"],
        ["slow", "TimeoutError", { argv: ["slow"], code: 1 }],
      ]);
    });

    test("emits dep-failure for dependency-failure skips", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      const g = new Graph();
      g.add({
        name: "a",
        kind: "root",
        deps: [],
        config: "1",
        params: p("root"),
        action: async () => {
          throw new Error("boom");
        },
      });
      g.add({
        name: "b",
        kind: "child",
        deps: ["a"],
        config: "2",
        params: p("child", { a: "a" }),
        action: async () => "b",
      });

      const actions: ExecEvent[] = [];
      await execute(g, ctx(cache, fs), { onEvent: (a) => actions.push(a) });

      const types = actions.map((a) => `${a.type}:${a.node.name}`);
      expect(types).toEqual([
        "dispatch:a",
        "start:a",
        "fail:a",
        "settled:a",
        "dep-failed:b",
        "settled:b",
      ]);
      const depFail = actions.find((a) => a.type === "dep-failed")!;
      if (depFail.type === "dep-failed") {
        expect(depFail.error).toBeInstanceOf(Error);
        expect((depFail.error as Error).message).toBe("dependency a failed");
      }
    });
  });

  describe("verify outputs on cache hit", () => {
    test("deleted output causes re-execution", async () => {
      const files = new Map<string, string>();
      const hashFile = async (path: string) => {
        const data = files.get(path);
        if (data === undefined) throw new Error(`ENOENT: ${path}`);
        return new Bun.CryptoHasher("sha256").update(data).digest("hex");
      };
      const cache = new MemCache();
      const dagFs = {
        exists: async () => true,
        readText: async () => "",
        writeText: async () => {},
        hashFile,
        ensureDir: async () => {},
      };
      const executionCtx: ExecutionContext = { cache, fs: dagFs, casBaseDir: "/cas" };
      const makeGraph = () => {
        const g = new Graph();
        g.add({
          name: "a",
          kind: "root",
          deps: [],
          config: "1",
          params: p("root"),
          action: async () => {
            files.set("a.txt", "content-a");
            return "a.txt";
          },
        });
        return g;
      };

      let results = await execute(makeGraph(), executionCtx);
      expect(countExec(results)).toEqual({ exec: 1, skip: 0 });

      results = await execute(makeGraph(), executionCtx);
      expect(countExec(results)).toEqual({ exec: 0, skip: 1 });

      files.delete("a.txt");
      results = await execute(makeGraph(), executionCtx);
      expect(countExec(results)).toEqual({ exec: 1, skip: 0 });
    });

    test("corrupted output causes re-execution", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      const makeGraph = () => {
        const g = new Graph();
        g.add({
          name: "a",
          kind: "root",
          deps: [],
          config: "1",
          params: p("root"),
          action: async () => write(fs, "a.txt", "original"),
        });
        return g;
      };

      await execute(makeGraph(), ctx(cache, fs));
      await fs.writeText("a.txt", "tampered");

      const results = await execute(makeGraph(), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 1, skip: 0 });
    });
  });

  test("interrupted execution resumes from where it left off", async () => {
    const fs = createMemoryDagFs();
    const cache = new MemCache();
    let bShouldFail = true;

    const makeGraph = () => {
      const g = new Graph();
      g.add({
        name: "a",
        kind: "root",
        deps: [],
        config: "1",
        params: p("root"),
        action: async () => write(fs, "a.txt", "a"),
      });
      g.add({
        name: "b",
        kind: "mid",
        deps: ["a"],
        config: "2",
        params: p("mid", { a: "a" }),
        action: async () => {
          if (bShouldFail) throw new Error("transient failure");
          return write(fs, "b.txt", "b");
        },
      });
      g.add({
        name: "c",
        kind: "mid",
        deps: ["b"],
        config: "3",
        params: p("mid", { b: "b" }),
        action: async () => write(fs, "c.txt", "c"),
      });
      g.add({
        name: "d",
        kind: "leaf",
        deps: ["c"],
        config: "4",
        params: p("leaf", { c: "c" }),
        action: async () => write(fs, "d.txt", "d"),
      });
      return g;
    };

    const results1 = await execute(makeGraph(), ctx(cache, fs));
    const byName1 = Object.fromEntries(results1.map((r) => [r.name, r.status]));
    expect(byName1).toEqual({ a: "done", b: "fail", c: "dep-failed", d: "dep-failed" });

    bShouldFail = false;
    const actions: ExecEvent[] = [];
    const results2 = await execute(makeGraph(), ctx(cache, fs), {
      onEvent: (a) => actions.push(a),
    });
    const byName2 = Object.fromEntries(results2.map((r) => [r.name, r.status]));
    expect(byName2).toEqual({ a: "cached", b: "done", c: "done", d: "done" });

    const executed = actions.filter((a) => a.type === "start").map((a) => a.node.name);
    expect(executed).toEqual(["b", "c", "d"]);
  });

  describe("concurrencyLimits", () => {
    test("caps per-group concurrent execution", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      const g = new Graph();
      let peak = 0;
      let inflight = 0;

      for (let i = 0; i < 6; i++) {
        g.add({
          name: `heavy_${i}`,
          kind: "heavy",
          deps: [],
          config: `${i}`,
          concurrencyGroup: "heavy",
          params: p("heavy"),
          action: async () => {
            inflight++;
            peak = Math.max(peak, inflight);
            await Bun.sleep(20);
            inflight--;
            return write(fs, `heavy_${i}.txt`, `${i}`);
          },
        });
      }

      const results = await execute(g, ctx(cache, fs), {
        scheduler: throttledScheduler({ maxParallelism: 4, concurrencyLimits: { heavy: 2 } }),
      });
      expect(peak).toBe(2);
      expect(results.filter((r) => r.status === "done").length).toBe(6);
    });

    test("ungrouped nodes run at full parallelism alongside group-limited nodes", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      const g = new Graph();
      let groupPeak = 0;
      let groupInflight = 0;
      let totalPeak = 0;
      let totalInflight = 0;

      for (let i = 0; i < 3; i++) {
        g.add({
          name: `heavy_${i}`,
          kind: "heavy",
          deps: [],
          config: `h${i}`,
          concurrencyGroup: "heavy",
          params: p("heavy"),
          action: async () => {
            groupInflight++;
            totalInflight++;
            groupPeak = Math.max(groupPeak, groupInflight);
            totalPeak = Math.max(totalPeak, totalInflight);
            await Bun.sleep(30);
            groupInflight--;
            totalInflight--;
            return write(fs, `heavy_${i}.txt`, `${i}`);
          },
        });
        g.add({
          name: `light_${i}`,
          kind: "light",
          deps: [],
          config: `l${i}`,
          params: p("light"),
          action: async () => {
            totalInflight++;
            totalPeak = Math.max(totalPeak, totalInflight);
            await Bun.sleep(30);
            totalInflight--;
            return write(fs, `light_${i}.txt`, `${i}`);
          },
        });
      }

      const results = await execute(g, ctx(cache, fs), {
        scheduler: throttledScheduler({ maxParallelism: 6, concurrencyLimits: { heavy: 1 } }),
      });
      expect(groupPeak).toBe(1);
      expect(totalPeak).toBeGreaterThan(1);
      expect(results.filter((r) => r.status === "done").length).toBe(6);
    });

    test("does not affect cache keys", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();

      const makeGraph = (group?: string) => {
        const g = new Graph();
        const node: RunnableNode = {
          name: "a",
          kind: "task",
          deps: [],
          config: "cfg",
          params: p("task"),
          action: async () => write(fs, "a.txt", "content"),
        };
        if (group) node.concurrencyGroup = group;
        g.add(node);
        return g;
      };

      let results = await execute(makeGraph("heavy"), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 1, skip: 0 });

      results = await execute(makeGraph("other"), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 0, skip: 1 });

      results = await execute(makeGraph(), ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 0, skip: 1 });
    });

    test("multiple groups are enforced independently", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      const g = new Graph();
      let aPeak = 0;
      let aInflight = 0;
      let bPeak = 0;
      let bInflight = 0;

      for (let i = 0; i < 4; i++) {
        g.add({
          name: `a_${i}`,
          kind: "a",
          deps: [],
          config: `a${i}`,
          concurrencyGroup: "group_a",
          params: p("a"),
          action: async () => {
            aInflight++;
            aPeak = Math.max(aPeak, aInflight);
            await Bun.sleep(20);
            aInflight--;
            return write(fs, `a_${i}.txt`, `${i}`);
          },
        });
        g.add({
          name: `b_${i}`,
          kind: "b",
          deps: [],
          config: `b${i}`,
          concurrencyGroup: "group_b",
          params: p("b"),
          action: async () => {
            bInflight++;
            bPeak = Math.max(bPeak, bInflight);
            await Bun.sleep(20);
            bInflight--;
            return write(fs, `b_${i}.txt`, `${i}`);
          },
        });
      }

      const results = await execute(g, ctx(cache, fs), {
        scheduler: throttledScheduler({
          maxParallelism: 8,
          concurrencyLimits: { group_a: 1, group_b: 2 },
        }),
      });
      expect(aPeak).toBe(1);
      expect(bPeak).toBe(2);
      expect(results.filter((r) => r.status === "done").length).toBe(8);
    });
  });

  describe("structured config via defineAction", () => {
    test("object config produces deterministic cache keys", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();

      const action = defineAction<null, BaseParams, string, { version: number; flag: boolean }>({
        config: { version: 1, flag: true },
        action: (_ctx, _config) => async () => write(fs, "out.txt", "result"),
      });

      const g = new Graph();
      action.addNode(g, null, { kind: "test" });
      let results = await execute(g, ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 1, skip: 0 });

      const g2 = new Graph();
      action.addNode(g2, null, { kind: "test" });
      results = await execute(g2, ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 0, skip: 1 });
    });

    test("config object passed to action function", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();
      let receivedConfig: unknown;

      const action = defineAction<null, BaseParams, string, { model: string }>({
        config: { model: "gpt-4" },
        action: (_ctx, config) => async () => {
          receivedConfig = config;
          return write(fs, "out.txt", "result");
        },
      });

      const g = new Graph();
      action.addNode(g, null, { kind: "test" });
      await execute(g, ctx(cache, fs));
      expect(receivedConfig).toEqual({ model: "gpt-4" });
    });

    test("config change invalidates cache", async () => {
      const fs = createMemoryDagFs();
      const cache = new MemCache();

      const makeAction = (version: number) =>
        defineAction<null, BaseParams, string, { version: number }>({
          config: { version },
          action: (_ctx, _config) => async () => write(fs, "out.txt", "result"),
        });

      const g1 = new Graph();
      makeAction(1).addNode(g1, null, { kind: "test" });
      let results = await execute(g1, ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 1, skip: 0 });

      const g2 = new Graph();
      makeAction(2).addNode(g2, null, { kind: "test" });
      results = await execute(g2, ctx(cache, fs));
      expect(countExec(results)).toEqual({ exec: 1, skip: 0 });
    });
  });

  test("diamond-with-failure: D dep-fails when B fails but C succeeds", async () => {
    const fs = createMemoryDagFs();
    const cache = new MemCache();
    const g = new Graph();
    g.add({
      name: "a",
      kind: "root",
      deps: [],
      config: "1",
      params: p("root"),
      action: async () => write(fs, "a.txt", "a"),
    });
    g.add({
      name: "b",
      kind: "mid",
      deps: ["a"],
      config: "2",
      params: p("mid", { a: "a" }),
      action: async () => {
        throw new Error("b failed");
      },
    });
    g.add({
      name: "c",
      kind: "mid",
      deps: ["a"],
      config: "3",
      params: p("mid", { a: "a" }),
      action: async () => write(fs, "c.txt", "c"),
    });
    g.add({
      name: "d",
      kind: "leaf",
      deps: ["b", "c"],
      config: "4",
      params: p("leaf", { b: "b", c: "c" }),
      action: async () => write(fs, "d.txt", "d"),
    });

    const results = await execute(g, ctx(cache, fs));
    const byName = Object.fromEntries(results.map((r) => [r.name, r.status]));
    expect(byName).toEqual({
      a: "done",
      b: "fail",
      c: "done",
      d: "dep-failed",
    });
  });

  test("optional dep: dependent runs without it, then re-runs once it succeeds", async () => {
    const fs = createMemoryDagFs();
    const cache = new MemCache();
    let ready = false;
    const received: (string | undefined)[] = [];
    const captions = defineAction<null, { kind: "captions" }, string>({
      config: "1",
      action: () => async () => {
        if (!ready) throw new Error("not ready");
        return write(fs, "captions.srt", "hello");
      },
    });
    const entry = defineAction<
      null,
      { kind: "entry"; deps: { captions: OptionalRef<string> } },
      string
    >({
      config: "1",
      action: () => async (_p, inputs) => {
        received.push(inputs.captions);
        return write(fs, "entry.txt", inputs.captions ?? "none");
      },
    });
    const run = async () => {
      const g = new Graph();
      const captionsRef = captions.addNode(g, null, { kind: "captions" });
      entry.addNode(g, null, { kind: "entry", deps: { captions: optional(captionsRef) } });
      const results = await execute(g, ctx(cache, fs));
      return Object.fromEntries(results.map((r) => [r.name, r.status]));
    };

    expect(await run()).toEqual({ captions: "fail", entry: "done" });
    expect(await run()).toEqual({ captions: "fail", entry: "cached" });
    ready = true;
    expect(await run()).toEqual({ captions: "done", entry: "done" });
    expect(await run()).toEqual({ captions: "cached", entry: "cached" });
    expect(received).toEqual([undefined, "captions.srt"]);
  });

  test("a node two roles name is one dep: the dependent runs once with it in both roles, and stays required when one role is optional", async () => {
    const fs = createMemoryDagFs();
    let broken = false;
    const runs: unknown[] = [];
    const src = defineAction<null, { kind: "src" }, string>({
      config: "1",
      action: () => async () => {
        if (broken) throw new Error("src broke");
        return write(fs, "src.txt", "src");
      },
    });
    const both = defineAction<
      null,
      { kind: "both"; deps: { main: NodeRef<string>; after: OptionalRef<string> } },
      string
    >({
      config: "1",
      action: () => async (_p, inputs) => {
        runs.push(inputs);
        return write(fs, "both.txt", "both");
      },
    });
    const run = async () => {
      const g = new Graph();
      const ref = src.addNode(g, null, { kind: "src" });
      both.addNode(g, null, { kind: "both", deps: { main: ref, after: optional(ref) } });
      const results = await execute(g, ctx(new MemCache(), fs));
      return Object.fromEntries(results.map((r) => [r.name, r.status]));
    };

    const ok = await run();
    broken = true;
    expect({ ok, srcBroken: await run(), runs }).toEqual({
      ok: { src: "done", both: "done" },
      srcBroken: { src: "fail", both: "dep-failed" },
      runs: [{ main: "src.txt", after: "src.txt" }],
    });
  });

  test("cancel: waiting nodes settle as cancelled; a running one is cancelled whatever its action returns, never cached; dependents never start", async () => {
    const fs = createMemoryDagFs();
    const cache = new MemCache();
    const seen: string[] = [];
    const action = (name: string, body: (signal?: AbortSignal) => Promise<void>) =>
      defineAction<null, { kind: string; deps?: Record<string, { name: string }> }, string>({
        config: "1",
        action: () => async (_p, _i, _dir, ctx) => {
          seen.push(name);
          await body(ctx?.signal);
          return write(fs, `${name}.txt`, name);
        },
      });
    // `slow` traps the cancel and returns normally, as a command that exits 0 on SIGINT does.
    let cancelling = true;
    const slow = action("slow", (signal) =>
      cancelling
        ? new Promise((resolve) => signal!.addEventListener("abort", () => resolve()))
        : Promise.resolve(),
    );
    const quick = action("quick", async () => {});
    const after = action("after", async () => {});
    const never = action("never", async () => {});
    const g = new Graph();
    const slowRef = slow.addNode(g, null, { kind: "slow" });
    const quickRef = quick.addNode(g, null, { kind: "quick" });
    after.addNode(g, null, { kind: "after", deps: { quick: quickRef } });
    never.addNode(g, null, { kind: "never", deps: { slow: slowRef } });
    const controller = new AbortController();
    const events: string[] = [];
    const results = await execute(g, ctx(cache, fs), {
      scheduler: throttledScheduler({ maxParallelism: 2 }),
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === "start" || e.type === "cancelled") events.push(`${e.type}:${e.node.name}`);
        // quick settles first; `after` is then ready, and the cancel lands before it starts.
        if (e.type === "settled" && e.node.name === "quick") controller.abort();
      },
    });
    cancelling = false;
    const rerun = await execute(g, ctx(cache, fs));
    const statuses = (rs: ExecResult[]) => Object.fromEntries(rs.map((r) => [r.name, r.status]));
    expect({
      ran: seen,
      statuses: statuses(results),
      started: results.filter((r) => r.actionKey !== "").map((r) => r.name),
      events,
      tally: tally(results),
      rerun: statuses(rerun),
    }).toEqual({
      ran: ["slow", "quick", "slow", "after", "never"],
      statuses: { slow: "cancelled", quick: "done", after: "cancelled", never: "cancelled" },
      started: ["quick", "slow"],
      events: ["start:slow", "start:quick", "cancelled:after", "cancelled:slow", "cancelled:never"],
      tally: { done: 1, cached: 0, fail: 0, depFailed: 0, cancelled: 3 },
      rerun: { quick: "cached", slow: "done", after: "done", never: "done" },
    });
  });

  test("timeoutMs: the action's signal aborts with a TimeoutError, the node fails whatever it returns and is never cached, and the timeout is not in the key", async () => {
    const fs = createMemoryDagFs();
    const cache = new MemCache();
    const reasons: string[] = [];
    const node = (name: string, timeoutMs: number, body: (signal: AbortSignal) => Promise<void>) =>
      defineAction<null, { kind: string; deps?: Record<string, NodeRef | OptionalRef> }, string>({
        config: "1",
        timeoutMs,
        action: () => async (_p, _i, _dir, ctx) => {
          await body(ctx!.signal!);
          return write(fs, `${name}.txt`, name);
        },
      });
    // `hung` waits for its signal and then returns normally, as a test runner that exits 0 on SIGINT does.
    const build = (quickTimeoutMs: number) => {
      const g = new Graph();
      const hung = node(
        "hung",
        20,
        (signal) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => {
              reasons.push((signal.reason as Error).name);
              resolve();
            }),
          ),
      ).addNode(g, null, { kind: "hung" });
      node("quick", quickTimeoutMs, async () => {}).addNode(g, null, { kind: "quick" });
      node("needs", 1000, async () => {}).addNode(g, null, { kind: "needs", deps: { hung } });
      node("report", 1000, async () => {}).addNode(g, null, {
        kind: "report",
        deps: { hung: optional(hung) },
      });
      return g;
    };
    const first = await execute(build(1000), ctx(cache, fs));
    const second = await execute(build(5000), ctx(cache, fs));
    const summarize = (rs: ExecResult[]) =>
      Object.fromEntries(
        rs.map((r) => [
          r.name,
          r.status === "fail" ? [r.status, r.error.name, r.error.message] : r.status,
        ]),
      );
    expect({
      first: summarize(first),
      second: summarize(second),
      reasons,
      timeoutOnNode: build(1000)
        .describe()
        .map((n) => [n.name, n.timeoutMs]),
    }).toEqual({
      first: {
        hung: ["fail", "TimeoutError", "timed out after 20 ms"],
        quick: "done",
        needs: "dep-failed",
        report: "done",
      },
      second: {
        hung: ["fail", "TimeoutError", "timed out after 20 ms"],
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
    const fs = createMemoryDagFs();
    const controller = new AbortController();
    const g = new Graph();
    defineAction<null, { kind: string }, string>({
      config: "1",
      timeoutMs: 10,
      action: () => async (_p, _i, _dir, ctx) => {
        await new Promise((resolve) => ctx!.signal!.addEventListener("abort", resolve));
        controller.abort();
        return write(fs, "late.txt", "late");
      },
    }).addNode(g, null, { kind: "late" });
    const events: string[] = [];
    const [result] = await execute(g, ctx(new MemCache(), fs), {
      signal: controller.signal,
      onEvent: (e) => void (e.type !== "settled" && events.push(e.type)),
    });
    expect({ status: result!.status, started: result!.actionKey !== "", events }).toEqual({
      status: "cancelled",
      started: true,
      events: ["dispatch", "start", "cancelled"],
    });
  });

  test("a cancel that lands while the node's output directory is made holds the action back", async () => {
    const controller = new AbortController();
    const fs = createMemoryDagFs();
    const slowMkdir: DagFs = {
      ...fs,
      ensureDir: async (path) => {
        controller.abort();
        await fs.ensureDir(path);
      },
    };
    const g = new Graph();
    let ran = false;
    defineAction<null, { kind: string }, string>({
      config: "1",
      action: () => async () => {
        ran = true;
        return write(fs, "x.txt", "x");
      },
    }).addNode(g, null, { kind: "x" });
    const results = await execute(g, ctx(new MemCache(), slowMkdir), { signal: controller.signal });
    expect({ ran, results }).toEqual({
      ran: false,
      results: [{ name: "x", actionKey: "", status: "cancelled" }],
    });
  });

  test("timeoutMs must be a whole number of ms that setTimeout honors", () => {
    const add = (timeoutMs: number) => () =>
      new Graph().add({
        name: "n",
        kind: "n",
        deps: [],
        config: "1",
        timeoutMs,
        params: p("n"),
        action: async () => "n",
      });
    const rejected = [0, -1, 1.5, Number.NaN, Infinity, 2 ** 31].filter((t) => {
      try {
        add(t)();
        return false;
      } catch (e) {
        return e instanceof RangeError;
      }
    });
    expect({ rejected, accepted: [add(1)(), add(2 ** 31 - 1)()] }).toEqual({
      rejected: [0, -1, 1.5, Number.NaN, Infinity, 2 ** 31],
      accepted: ["n", "n"],
    });
  });

  describe("cycle prevention", () => {
    test("Graph.add() rejects deps on unknown nodes, preventing cycles", () => {
      const g = new Graph();
      expect(() =>
        g.add({
          name: "a",
          kind: "root",
          deps: ["b"],
          config: "1",
          params: p("root"),
          action: async () => "a",
        }),
      ).toThrow('node "a" depends on unknown node "b"');
    });

    test("validateNoCycles detects cycles in manually constructed maps", () => {
      const nodes = new Map<string, { deps: string[] }>([
        ["a", { deps: ["c"] }],
        ["b", { deps: ["a"] }],
        ["c", { deps: ["b"] }],
      ]);
      expect(() => validateNoCycles(nodes)).toThrow("cycle detected");
    });
  });
});
