import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { type FileSystem } from "./cache/index.ts";
import { execute, startGlobalTimer, wallClock } from "./execute.ts";
import { createBunFileSystem } from "./filesystem/bun.ts";
import { createMemoryFileSystem } from "./filesystem/index.ts";
import { createNodeFileSystem } from "./filesystem/node.ts";
import {
  actionsFor,
  dep,
  Graph,
  isFileHandle,
  namedOutput,
  nodeInputs,
  settled,
  type ActionContext,
  type DepRecord,
  type DepSpecs,
  type Handles,
  type NodeInputs,
  type NodeRef,
  type Outputs,
  type SettledOutputRef,
} from "./graph/index.ts";
import { type NodeResult } from "./lookup-or-run/index.ts";
import { throttledScheduler } from "./schedulers/index.ts";

interface Ports {
  fs: FileSystem;
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

function setup() {
  const fs = createMemoryFileSystem();
  return {
    fs,
    ctx: { ports: { fs }, fs, cacheDir: "/cache", clock: wallClock, startTimer: startGlobalTimer },
  };
}

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

describe("the cache", () => {
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

test("a cacheable: false node runs again each execution, and its dependents still cache by its content", async () => {
  const { ctx } = setup();
  const build = () => {
    const g = new Graph<Ports>();
    const probe = task(g, "probe", { cacheable: false, run: () => "same-every-time" });
    task(g, "report", { deps: { probe } });
    return g;
  };
  await execute(build(), ctx);
  expect(statuses(await execute(build(), ctx))).toEqual({ probe: "ran", report: "hit" });
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

test("a cancelled execution returns a result for every node: the one that ran, the one cancelled while it ran, and those it never started", async () => {
  const { ctx } = setup();
  const g = new Graph<Ports>();
  // `slow` traps the cancel and returns normally, as a command that exits 0 on SIGINT does.
  const slow = task(g, "slow", {
    run: async (c) => {
      await new Promise((r) => c.signal.addEventListener("abort", r));
      return undefined;
    },
  });
  const quick = task(g, "quick");
  task(g, "after", { deps: { quick } });
  task(g, "never", { deps: { slow } });
  const controller = new AbortController();
  const results = await execute(g, ctx, {
    scheduler: throttledScheduler({ maxParallelism: 2 }),
    signal: controller.signal,
    onEvent: (e) => {
      // quick settles first; `after` is then ready, and the cancel lands before it starts.
      if (e.type === "result" && e.node === "quick") controller.abort();
    },
  });
  expect(statuses(results)).toEqual({
    quick: "ran",
    after: "cancelled",
    slow: "cancelled",
    never: "cancelled",
  });
});
