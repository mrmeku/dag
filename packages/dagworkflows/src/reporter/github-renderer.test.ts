import {
  createMemoryFileSystem,
  type ExecutionEvent,
  type Node,
  type NodeResult,
} from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createRecordingHost } from "../recording/index.ts";
import { createRunStore } from "../run-store/index.ts";
import { githubRenderer } from "./github-renderer.ts";

const node = (name: string, deps: string[] = []): Node => ({ name, kind: name, deps });
const resultEvent = (result: NodeResult, occurredAt: number): ExecutionEvent => ({
  type: "result",
  node: result.name,
  result,
  occurredAt,
});
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

describe("GitHub renderer", () => {
  test("a failure, then a cancel that catches one node running and one queued, as the job shows them; check runs queue behind each other and the pass's end waits for them; the reproduce line starts with the renderer's own command", async () => {
    const rec = createRecordingHost();
    // The checks API answers after the log has moved on, a start slower than a completion.
    rec.host.check = async (update) => {
      await new Promise(setImmediate);
      if (update.status === "in_progress") await new Promise(setImmediate);
      rec.checks.push(update);
    };
    const nodes = [
      node("lint docs"),
      node("slow", ["lint docs"]),
      node("queued"),
      node("after", ["slow"]),
    ];
    const pass = {
      banner: { title: "ci.ts · 4 nodes", lines: nodes.map(({ name }) => name) },
      title: "ci.ts",
      nodes,
      rerunCommand: "npx --no dag run other.ts",
    };
    const store = createRunStore({
      fs: createMemoryFileSystem(),
      durationsFile: "/durations/ci.ts.json",
      listeners: [githubRenderer(rec.host, { rerunCommand: "npx --no dag run ci.ts" })],
    });
    store.begin(pass);
    const events: ExecutionEvent[] = [
      { type: "dispatch", node: "lint docs", occurredAt: 0 },
      { type: "start", node: "lint docs", occurredAt: 1000 },
      { type: "output", node: "lint docs", chunk: "src/a.ts: error\n", occurredAt: 1500 },
      resultEvent(
        {
          name: "lint docs",
          status: "failed",
          error: {
            name: "Error",
            message: "lint exited 1",
            cause: { argv: ["lint"], cwd: ".", ended: "exited", code: 1 },
          },
          details: { actionKey: "kl", elapsed: 1000 },
        },
        2000,
      ),
      { type: "dispatch", node: "slow", occurredAt: 3000 },
      { type: "start", node: "slow", occurredAt: 4000 },
      // Held back by its concurrency group: it looked its key up but never ran.
      { type: "dispatch", node: "queued", occurredAt: 5000 },
      { type: "pending", node: "queued", occurredAt: 5000 },
      { type: "output", node: "slow", chunk: "compiling\n", occurredAt: 5500 },
      resultEvent({ name: "queued", status: "cancelled", details: { actionKey: "kq" } }, 6000),
      resultEvent(
        { name: "slow", status: "cancelled", details: { actionKey: "ks", elapsed: 3000 } },
        7000,
      ),
      resultEvent({ name: "after", status: "cancelled" }, 7000),
    ];
    for (const event of events) store.onEvent(event);
    store.cancel();
    await store.finish(pass, await store.report(pass));
    assert.deepEqual(
      { log: rec.log, annotations: rec.annotations, checks: rec.checks },
      {
        log: [
          { title: "ci.ts · 4 nodes", lines: ["lint docs", "slow", "queued", "after"] },
          "▷ lint docs",
          {
            title: "✖︎ lint docs (1.0s)",
            lines: ["src/a.ts: error", "── error ──", "lint exited 1"],
          },
          "▷ slow",
          "◼︎ queued: cancelled",
          { title: "◼︎ slow (cancelled)", lines: ["compiling"] },
          "◼︎ after: cancelled",
          "",
          "✖︎ lint docs failed · ci.ts · built 0 · cached 0 · failed 1 · skipped 0 · cancelled 3 · wall 6.0s",
          "failed: lint docs",
          "cancelled: slow, queued, after",
          "reproduce: npx --no dag run ci.ts --only 'lint docs'",
        ],
        annotations: [{ level: "error", title: "lint docs", message: "lint exited 1" }],
        checks: [
          { name: "lint docs", status: "in_progress", startedAt: iso(1) },
          { name: "slow", status: "in_progress", startedAt: iso(4) },
          {
            name: "lint docs",
            status: "completed",
            conclusion: "failure",
            startedAt: iso(1),
            completedAt: iso(2),
            summary: "lint exited 1",
          },
          {
            name: "queued",
            status: "completed",
            conclusion: "cancelled",
            completedAt: iso(6),
            summary: "cancelled",
          },
          {
            name: "slow",
            status: "completed",
            conclusion: "cancelled",
            startedAt: iso(4),
            completedAt: iso(7),
            summary: "cancelled",
          },
          {
            name: "after",
            status: "completed",
            conclusion: "cancelled",
            completedAt: iso(7),
            summary: "cancelled",
          },
        ],
      },
    );
  });

  test("a post pass carries no command, so a renderer given its own draws no reproduce line for it", async () => {
    const rec = createRecordingHost();
    const renderer = githubRenderer(rec.host, { rerunCommand: "npx --no dag run 'ci flows.ts'" });
    const down = node("down:db");
    await renderer.finish?.({ title: "ci flows.ts · post", nodes: [down] }, [
      {
        node: down,
        result: {
          name: "down:db",
          status: "failed",
          error: { name: "Error", message: "db exited 1" },
          details: { actionKey: "kd", elapsed: 1000 },
        },
        start: 0,
        duration: 1000,
      },
    ]);
    assert.deepEqual(rec.log, [
      "",
      "✖︎ down:db failed · ci flows.ts · post · built 0 · cached 0 · failed 1 · skipped 0 · wall 1.0s",
      "failed: down:db",
    ]);
  });
});
