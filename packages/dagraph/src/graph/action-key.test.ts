import { describe, expect, test } from "bun:test";
import { sha256 } from "js-sha256";

import {
  actionsFor,
  computeActionKey,
  file,
  Graph,
  graphNodes,
  maybe,
  nodeInputs,
  pick,
  settled,
  type DepRecord,
  type DepSpecs,
  type InputRecord,
  type NodeInputs,
  type NodeRef,
  type OutputRef,
} from "./index.ts";

/** Never called: a key reads no action. */
interface Ports {
  write: (path: string, text: string) => Promise<void>;
}

const defineActionWithPorts = actionsFor<Ports, "heavy">();
/** Deps in any role, as an action declares a record that its nodes name. */
const anyRole: DepSpecs = {};

/** What each file holds, by path, for the hashing double. */
const files = new Map<string, string>();
const hashFile = async (path: string) => {
  const content = files.get(path);
  if (content === undefined) throw new Error(`ENOENT: ${path}`);
  return sha256.hex(content);
};

/** Each node's action key, its deps' outputs hashing as `outputHashes` gives them by dep name. */
async function keysOf<Meta>(
  graph: Graph<Ports, Meta>,
  outputHashes: Record<string, Record<string, string>> = {},
): Promise<Record<string, string>> {
  const keys: Record<string, string> = {};
  for (const [name, node] of graphNodes(graph))
    keys[name] = await computeActionKey(node, outputHashes, hashFile);
  return keys;
}

/** A node of the action `task`. Its name is also an input, `id`, so no two nodes share a key. */
function task<D extends DepRecord = Record<never, never>>(
  g: Graph<Ports>,
  name: string,
  opts: { deps?: D; inputs?: NodeInputs<Record<never, never>, Record<never, never>, D> } = {},
): NodeRef<{ out: string }> {
  const { deps, inputs } = opts;
  return defineActionWithPorts({
    kind: "task",
    deps: anyRole,
    action: async (c) => ({ out: `${c.outputDir}/out` }),
  }).addNode(g, {
    name,
    ...(deps && { deps }),
    inputs: (refs) => ({ id: name, ...(typeof inputs === "function" ? inputs(refs) : inputs) }),
  });
}

describe("the action key", () => {
  test("the kind, inputs and deps identify an action: not its function or how-to-run fields, nor the node's name or meta", async () => {
    const make = (kind: string, content: string, group?: "heavy") =>
      defineActionWithPorts({
        kind,
        inputs: { version: 1 },
        ...(group && { concurrencyGroup: group, timeoutMs: 1000 }),
        action: async (c) => ({ out: `${c.outputDir}/${content}` }),
      });
    const first = new Graph<Ports, { video: string }>();
    make("one", "made by one").addNode(first, { name: "a", meta: { video: "x" } });
    const second = new Graph<Ports, { video: string }>();
    make("one", "made again", "heavy").addNode(second.subgraph("v", { video: "y" }), {
      name: "b",
    });
    const third = new Graph<Ports, { video: string }>();
    make("two", "made by two").addNode(third, { name: "a", meta: { video: "x" } });
    const [one] = Object.values(await keysOf(first));
    const [again] = Object.values(await keysOf(second));
    const [two] = Object.values(await keysOf(third));
    expect({ again: again === one, two: two === one }).toEqual({ again: true, two: false });
  });

  test("deps key by role: renaming nodes re-keys nothing, swapping deps between roles re-keys", async () => {
    const joinKey = async (names: [string, string], swap = false) => {
      const g = new Graph<Ports>();
      const a = task(g, names[0], { inputs: { id: "A" } });
      const b = task(g, names[1], { inputs: { id: "B" } });
      task(g, "join", { deps: swap ? { left: b, right: a } : { left: a, right: b } });
      const outputHashes = { [names[0]]: { out: "A" }, [names[1]]: { out: "B" } };
      return (await keysOf(g, outputHashes))["join"];
    };
    const first = await joinKey(["a", "b"]);
    expect({
      renamed: (await joinKey(["x", "y"])) === first,
      swapped: (await joinKey(["x", "y"], true)) === first,
    }).toEqual({ renamed: true, swapped: false });
  });

  test("a value input keys as JSON with sorted keys and undefined properties dropped", async () => {
    const keyOf = async (inputs: InputRecord) => {
      const g = new Graph<Ports>();
      task(g, "n", { inputs });
      return (await keysOf(g))["n"];
    };
    const first = await keyOf({ opts: { a: 1, b: [1, 2] } });
    expect({
      reordered:
        (await keyOf({ opts: { b: [1, 2], a: 1, c: undefined }, gone: undefined })) === first,
      stringNotNumber: (await keyOf({ opts: { a: "1", b: [1, 2] } })) === first,
      listReordered: (await keyOf({ opts: { a: 1, b: [2, 1] } })) === first,
    }).toEqual({ reordered: true, stringNotNumber: false, listReordered: false });
  });

  test("a file input keys on its path and its content's hash, and the same path as a value keys otherwise", async () => {
    const keyOf = async (src: InputRecord[string]) => {
      const g = new Graph<Ports>();
      task(g, "n", { inputs: { src } });
      return (await keysOf(g))["n"];
    };
    files.set("/src/a.ts", "a1");
    files.set("/src/b.ts", "a1");
    const first = await keyOf(file("/src/a.ts"));
    const otherPath = await keyOf(file("/src/b.ts"));
    files.set("/src/a.ts", "a2");
    expect({
      otherPath: otherPath === first,
      edited: (await keyOf(file("/src/a.ts"))) === first,
      asValue: (await keyOf("/src/a.ts")) === first,
    }).toEqual({ otherPath: false, edited: false, asValue: false });
  });

  test("an output ref keys by role and output name, not by its path, so a dep rebuilt to the same content keeps its dependent's key", async () => {
    const pack = defineActionWithPorts({
      kind: "pack",
      nodeInputs: nodeInputs<{ version: string }>,
      action: async (c) => ({
        tarball: `${c.outputDir}/pkg.tgz`,
        notes: `${c.outputDir}/notes.md`,
      }),
    });
    const publish = defineActionWithPorts({
      kind: "publish",
      deps: { pack },
      nodeInputs: nodeInputs<{ cmd: (string | OutputRef<string>)[] }>,
      action: async (c) => ({ out: `${c.outputDir}/cmd.json` }),
    });
    const publishKey = async (version: string, tarball: string) => {
      const g = new Graph<Ports>();
      const p = pack.addNode(g, { inputs: { version } });
      publish.addNode(g, {
        deps: { pack: p },
        inputs: ({ pack }) => ({ cmd: ["npm", "publish", pack.tarball] }),
      });
      return (await keysOf(g, { pack: { tarball, notes: "notes" } }))["publish"];
    };
    const first = await publishKey("1.0", "pkg");
    expect({
      sameContent: (await publishKey("1.1", "pkg")) === first,
      otherContent: (await publishKey("1.1", "other pkg")) === first,
    }).toEqual({ sameContent: true, otherContent: false });
  });

  test("a role that picks some of its dep's outputs keys on those alone, settled or maybe", async () => {
    const pair = defineActionWithPorts({
      kind: "pair-of-files",
      action: async (c) => ({ main: `${c.outputDir}/main`, extra: `${c.outputDir}/extra` }),
    });
    const required = defineActionWithPorts({
      kind: "required",
      deps: { pair: pick(pair, "main") },
      action: async (c) => ({ out: `${c.outputDir}/out` }),
    });
    const settledRole = defineActionWithPorts({
      kind: "settled",
      deps: { pair: settled(pick(pair, "main")) },
      action: async (c) => ({ out: `${c.outputDir}/out` }),
    });
    const maybeRole = defineActionWithPorts({
      kind: "maybe",
      deps: { pair: maybe(pick(pair, "main")) },
      action: async (c) => ({ out: `${c.outputDir}/out` }),
    });
    const whole = defineActionWithPorts({
      kind: "whole",
      deps: { pair },
      action: async (c) => ({ out: `${c.outputDir}/out` }),
    });
    const keysWith = async (main: string, extra: string) => {
      const g = new Graph<Ports>();
      const p = pair.addNode(g, {});
      required.addNode(g, { deps: { pair: p } });
      settledRole.addNode(g, { deps: { pair: settled(p) } });
      maybeRole.addNode(g, { deps: { pair: p } });
      whole.addNode(g, { deps: { pair: p } });
      const {
        required: r,
        settled: s,
        maybe: m,
        whole: w,
      } = await keysOf(g, {
        "pair-of-files": { main, extra },
      });
      return [r, s, m, w];
    };
    const first = await keysWith("a", "x");
    const extraChanged = await keysWith("a", "y");
    const mainChanged = await keysWith("b", "y");
    expect({
      extraChanged: extraChanged.map((key, i) => key === first[i]),
      mainChanged: mainChanged.map((key, i) => key === first[i]),
    }).toEqual({
      extraChanged: [true, true, true, false],
      mainChanged: [false, false, false, false],
    });
  });
});

describe("refs in the key", () => {
  type Pair = { main: string; extra: string };
  const pair = defineActionWithPorts({
    kind: "pair",
    inputs: { version: 1 },
    action: async (c) => ({ main: `${c.outputDir}/m`, extra: `${c.outputDir}/e` }),
  });
  /**
   * What each output of a node of `pair` hashes to, its files "m" and "e" each holding "same",
   * as the cache's tests pin them.
   */
  const pairHashes = {
    main: "11512a3e377495cf8b673d3cf67bccc3127646b0ba514134912ba2e1f1bbe5e3",
    extra: "463c8e0c18bb099e0382ab3e094d3ac18b237bb7c2bfea73cc579bea35bb5181",
  };
  /** The key of `use`, a node `declare` adds beside p and q, two nodes of `pair`. */
  const keyOfUse = async (
    names: [string, string],
    declare: (g: Graph<Ports>, p: NodeRef<Pair>, q: NodeRef<Pair>) => void,
  ) => {
    // p and q share one declaration, so one entry: they differ in name and role only.
    const g = new Graph<Ports>();
    declare(g, pair.addNode(g, { name: names[0] }), pair.addNode(g, { name: names[1] }));
    return (await keysOf(g, { [names[0]]: pairHashes, [names[1]]: pairHashes }))["use"];
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
    const leftMain = await keyOfUse(["p", "q"], leftAndRight("left", "main"));
    expect({
      renamed: (await keyOfUse(["x", "y"], leftAndRight("left", "main"))) === leftMain,
      otherOutput: (await keyOfUse(["p", "q"], leftAndRight("left", "extra"))) === leftMain,
      otherRole: (await keyOfUse(["p", "q"], leftAndRight("right", "main"))) === leftMain,
    }).toEqual({ renamed: true, otherOutput: false, otherRole: false });
  });

  test("a ref to a node two roles name keys by all its roles, in sorted order, through either role", async () => {
    const both = await keyOfUse(["p", "q"], twoRoles("main", "same"));
    expect({
      reordered: (await keyOfUse(["p", "q"], twoRoles("main", "reordered"))) === both,
      throughAlias: (await keyOfUse(["p", "q"], twoRoles("alias", "same"))) === both,
      oneRole: (await keyOfUse(["p", "q"], twoRoles("main", "split"))) === both,
    }).toEqual({ reordered: true, throughAlias: true, oneRole: false });
  });

  test("a ref from the inputs function keys as the same ref written from its node did", async () => {
    // The keys these nodes had when their refs were written as p.outputs.main (25a5ee4), but
    // for their kind, which joined the key later.
    expect({
      leftMain: await keyOfUse(["p", "q"], leftAndRight("left", "main")),
      twoRoles: await keyOfUse(["p", "q"], twoRoles("main", "same")),
    }).toEqual({
      leftMain: "592dd623a1ac0eddbeac5e2ff3a61046869ecc409f520fd7057efdebc71564a3",
      twoRoles: "b97bb03bf57c20b783a577f3f5d9efacdc3cc760527f8e01df06ab27acd0ab76",
    });
  });
});
