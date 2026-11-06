import { Graph } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addCache, type CachePorts } from "../actions-cache/index.ts";
import { addTask } from "../tasks/index.ts";
import { saveNodes, selectNodes } from "./index.ts";

const RUN = { cacheDir: "/cache", durationsDir: "/state/durations", runId: 1 };

/** What each of `names` depends on in `graph`, and which of those deps are settled. */
const depsOf = (graph: Graph<CachePorts>, names: string[]) =>
  Object.fromEntries(
    graph
      .describe()
      .filter((node) => names.includes(node.name))
      .map((node) => [node.name, { deps: node.deps, settled: node.settledDeps ?? [] }]),
  );
const refusal = (select: () => unknown) => {
  try {
    select();
    return "accepted";
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

describe("selectNodes", () => {
  test("keeps the named nodes and their deps, a named post's task and a named save's restore; an unknown name is refused", () => {
    const graph = new Graph<CachePorts>();
    const a = addTask(graph, { name: "a", cmd: ["a"] });
    const b = addTask(graph, { name: "b", cmd: ["b"], deps: { a } });
    addTask(graph, { name: "c", cmd: ["c"], deps: { b } });
    addTask(graph, { name: "d", cmd: ["d"], deps: { a } });
    addTask(graph, {
      name: "up:db",
      cmd: ["db", "start"],
      post: { name: "down:db", cmd: ["db", "stop"] },
    });
    addCache(graph, { name: "cache-dir", key: "cache-dir-1" }, RUN).save();
    const names = (selected: string[]) =>
      selectNodes(graph, selected)
        .describe()
        .map((node) => node.name);
    assert.deepEqual(
      {
        c: names(["c"]),
        post: names(["down:db"]),
        save: names(["save:cache-dir"]),
        unknown: refusal(() => selectNodes(graph, ["e"])),
      },
      {
        c: ["a", "b", "c"],
        post: ["up:db", "down:db"],
        save: ["restore:cache-dir", "save:cache-dir"],
        unknown: 'closure: the graph holds no node "e"',
      },
    );
  });

  test("makes a post wait, settled, for its task and every node downstream of it, through other nodes and the posts of downstream tasks, never for a post upstream", () => {
    const graph = new Graph<CachePorts>();
    const cacheDir = addTask(graph, {
      name: "cache-dir",
      cmd: ["cache-dir", "restore"],
      post: { name: "save", cmd: ["cache-dir", "save"] },
    });
    const db = addTask(graph, {
      name: "up:db",
      cmd: ["db", "start"],
      deps: { cacheDir },
      post: { name: "down:db", cmd: ["db", "stop"] },
    });
    const seed = addTask(graph, { name: "seed", cmd: ["seed"], deps: { db } });
    addTask(graph, {
      name: "e2e",
      cmd: ["e2e"],
      deps: { seed },
      post: { name: "dump", cmd: ["db", "dump"] },
    });
    assert.deepEqual(depsOf(selectNodes(graph), ["save", "down:db", "dump"]), {
      // Beside its settled task, a post requires what its task requires.
      dump: { deps: ["e2e", "seed"], settled: ["e2e"] },
      "down:db": {
        deps: ["up:db", "cache-dir", "seed", "e2e", "dump"],
        settled: ["up:db", "seed", "e2e", "dump"],
      },
      save: {
        deps: ["cache-dir", "up:db", "seed", "e2e", "down:db", "dump"],
        settled: ["cache-dir", "up:db", "seed", "e2e", "down:db", "dump"],
      },
    });
  });

  test("makes a save wait, settled, for every other selected node, one added after save() too, and for no post or other save", () => {
    const graph = new Graph<CachePorts>();
    const cacheDir = addCache(
      graph,
      { name: "cache-dir", path: [".dag/cache"], key: "cache-dir-1" },
      RUN,
    );
    addTask(graph, { name: "build", cmd: ["build"], deps: { cacheDir: cacheDir.restore } });
    cacheDir.save();
    addCache(graph, { name: "bun", key: "bun-1" }, RUN).save();
    addTask(graph, { name: "docs", cmd: ["docs"] });
    addTask(graph, {
      name: "up:db",
      cmd: ["compose", "up"],
      post: { name: "down:db", cmd: ["compose", "down"] },
    });
    const waits = ["build", "docs", "restore:bun", "restore:cache-dir", "up:db"];
    const selected = selectNodes(graph);
    const save = depsOf(selected, ["save:cache-dir"])["save:cache-dir"];
    assert.deepEqual(
      {
        deps: save?.deps.toSorted(),
        settled: save?.settled.toSorted(),
        saves: saveNodes(selected),
      },
      {
        deps: waits,
        settled: waits,
        saves: new Map([
          ["save:cache-dir", "restore:cache-dir"],
          ["save:bun", "restore:bun"],
        ]),
      },
    );
  });

  test("paying, keeps a post's settled dep on its task and its waits but drops what its task requires", () => {
    const graph = new Graph<CachePorts>();
    const image = addTask(graph, { name: "pull", cmd: ["pull"] });
    const db = addTask(graph, {
      name: "up:db",
      cmd: ["db", "start"],
      deps: { image },
      post: { name: "down:db", cmd: ["db", "stop"] },
    });
    addTask(graph, { name: "seed", cmd: ["seed"], deps: { db } });
    assert.deepEqual(
      {
        running: depsOf(selectNodes(graph), ["down:db"]),
        paying: depsOf(selectNodes(graph, undefined, true), ["down:db"]),
      },
      {
        running: { "down:db": { deps: ["up:db", "pull", "seed"], settled: ["up:db", "seed"] } },
        paying: { "down:db": { deps: ["up:db", "seed"], settled: ["up:db", "seed"] } },
      },
    );
  });
});
