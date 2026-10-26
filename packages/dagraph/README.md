# dagraph

[![npm](https://img.shields.io/npm/v/@mrmeku/dagraph)](https://www.npmjs.com/package/@mrmeku/dagraph)
[![CI](https://github.com/mrmeku/dag/actions/workflows/ci.yml/badge.svg)](https://github.com/mrmeku/dag/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@mrmeku/dagraph)](https://github.com/mrmeku/dag/blob/main/LICENSE)

Typed task graphs for TypeScript. A job that's been taken care of stays taken care of, until what it was handed changes.

## Why dagraph

You've got a chain of steps, each one slow or costly, each one reading what the last one wrote. Most of them bring back the same thing as last time, so why pay for them twice? dagraph sees to it that only the work that changed gets done. And a mistake in the wiring gets caught before the job starts, not halfway through it.

- **A content-addressed cache with early cutoff.** A node runs again when its inputs or its dependencies' content change. A node that reruns to the same bytes stops the change there.
- **Group limits that a cache hit never takes.** `throttledScheduler` caps how many nodes are processed at once. It also caps each **concurrency group**, a named limit that actions join, such as `network: 2`. A hit never takes a group's slot, so the slots go only to work that really runs.
- **Wiring checked early.** A dependency of the wrong output type does not compile. A missing dependency is refused the moment the node is added. And the graph cannot hold a cycle.

## Quick start

Install the package:

```sh
npm install @mrmeku/dagraph
```

Two actions: `count` counts the words of its text, and `report` writes a sentence from that count. The program runs the same graph three times against one cache on disk, the third time with new text. Save it as `quick.ts`:

```ts
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAction, execute, FsCache, Graph, nodeInputs } from "@mrmeku/dagraph";
import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";

const count = defineAction({
  kind: "count",
  inputs: { version: 1 },
  nodeInputs: nodeInputs<{ text: string }>,
  action: async ({ inputs, outputDir }) => {
    const path = join(outputDir, "count.txt");
    await writeFile(path, String(inputs.text.split(/\s+/).length));
    return path;
  },
});
const report = defineAction({
  kind: "report",
  deps: { count },
  action: async ({ depOutputs, outputDir }) => {
    const path = join(outputDir, "report.txt");
    await writeFile(path, `${await depOutputs.count.text()} words`);
    return path;
  },
});

const casBaseDir = join(await mkdtemp(join(tmpdir(), "quick-")), "cas");
const fs = createNodeDagFs();
const context = { cache: new FsCache(casBaseDir, fs), fs, casBaseDir };
async function run(text: string) {
  const graph = new Graph();
  report.addNode(graph, { deps: { count: count.addNode(graph, { inputs: { text } }) } });
  for (const r of await execute(graph, context)) console.log(r.name, r.status);
}
await run("hello big world");
await run("hello big world");
await run("goodbye small world");
```

Run `node quick.ts` or `bun quick.ts`. It prints:

```
count done
report done
count cached
report cached
count done
report cached
```

The first time, both of them do the job. The second time nothing changed, so nobody lifts a finger: both come back `cached`. The third time `count` gets new text and goes back to work. But it brings back `3`, same as before, so `report` stays put. That's early cutoff.

## How it works

An **action** is a kind of work, defined once with `defineAction`. Its `kind` names its logic. Its `deps` name the actions whose outputs it reads, each under a **role**. Its function returns the files it wrote. A **node** is one use of an action in a `Graph`. `addNode` returns a typed **ref** that you hand to the nodes that depend on it. A node can depend only on refs that already exist, so no cycle can be written.

A node's **action key** is a hash of its action's kind, its inputs and its dependencies' content by role, and nothing else. So when you change an action's logic, bump an input such as `version`. Outputs live in a content-addressed store, the **CAS**, under the context's `casBaseDir`. A dependent keys on what its dependency produced, not on whether it ran. That is **early cutoff**, and it is why `report` stayed `cached` on the third run.

Running a graph has two halves. Orchestration decides when each node runs and does no I/O. Processing looks up a node's key and, on a miss, runs the action and stores what it wrote. `execute` joins the two in one process. The engine itself starts no processes and reads no environment variables. Commands and credentials reach actions through **ports**, passed as `ports` in the context and never in the graph.

## Documentation

- Writing actions and wiring nodes: [Build a graph](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/graphs.md).
- A node ran again, or did not: [When a node runs again](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/caching.md).
- Limits, failures, cancellation, events, or an executor of your own: [Run a graph](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/execution.md).
- Every export: [the API reference](https://github.com/mrmeku/dag/blob/main/packages/dagraph/docs/api/README.md).
- CI as a graph: [`@mrmeku/dagworkflows`](https://github.com/mrmeku/dag/blob/main/packages/dagworkflows/README.md), a CI runner whose workflows run as dagraph graphs.

## License

[MIT](https://github.com/mrmeku/dag/blob/main/LICENSE).
