import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readJournal } from "./journal.ts";
import type { Sh } from "./ports.ts";
import { createMemoryActionsCache } from "./ports/actions-cache.ts";
import { createTestPorts } from "./ports/memory.ts";
import { runPost, runWorkflow } from "./runner.ts";
import { defineWorkflow } from "./workflow.ts";

const CAS = "/cas";
const JOURNAL = "/state/journal.json";

describe("cancel, then post", () => {
  test("a cancelled run journals what settled; the post pass saves the cache and stops the service from the journal; a second pass finds nothing", async () => {
    const controller = new AbortController();
    const calls: string[][] = [];
    const service = createMemoryActionsCache(["bun-old"]);
    const { ports, fs, rec } = createTestPorts({ actionsCache: service });
    // `db start` writes the pid it is asked for; `slow` runs until the cancel interrupts it.
    const sh: Sh = {
      run: async (cmd, opts) => {
        calls.push(cmd);
        if (cmd[0] === "db" && cmd[1] === "start")
          await fs.writeText(`${opts!.env!.DAGACTIONS_OUT}/pid`, "7");
        if (cmd[0] !== "slow") return { code: 0, stdout: "", stderr: "", ok: true };
        return new Promise((resolve) =>
          opts!.signal!.addEventListener("abort", () =>
            resolve({ code: -1, stdout: "", stderr: "killed by SIGINT\n", ok: false }),
          ),
        );
      },
    };
    ports.sh = sh;
    const workflow = defineWorkflow({
      build: (w) => {
        const bun = w.restoreCache({
          name: "restore:bun",
          path: ["~/.bun"],
          key: "bun-new",
          restoreKeys: ["bun-"],
        });
        const db = w.run({
          name: "up:db",
          cmd: ["db", "start"],
          outputs: { pid: "pid" },
          cacheable: false,
        });
        const fast = w.run({ name: "fast", cmd: ["fast"], deps: { bun, db }, cacheable: false });
        const slow = w.run({ name: "slow", cmd: ["slow"], deps: { bun, db }, cacheable: false });
        const after = w.run({ name: "after", cmd: ["after"], deps: { fast, slow } });
        w.saveCache({
          name: "save:bun",
          cache: bun,
          deps: { fast: w.optional(fast), slow: w.optional(slow) },
        });
        w.post({
          name: "down:db",
          main: db,
          cmd: ["db", "stop", db.outputs.pid],
          deps: { after: w.optional(after) },
        });
      },
    });
    const common = { workflow: workflow.workflow, ports, casBaseDir: CAS, journalPath: JOURNAL };
    const fastSettled = new Promise<void>((resolve) => {
      const group = ports.ci.group;
      ports.ci.group = (title, lines) => {
        group(title, lines);
        if (title.startsWith("✓ fast")) resolve();
      };
    });
    const running = runWorkflow({ ...common, signal: controller.signal });
    await fastSettled;
    controller.abort();
    const run = await running;
    const journal = await readJournal(fs, JOURNAL);
    const post = await runPost(common);
    const again = await runPost(common);
    const status = (rs: { name: string; status: string }[]) =>
      Object.fromEntries(rs.map((r) => [r.name, r.status]));
    const stop = calls.find((c) => c[1] === "stop")!;
    assert.deepEqual(
      {
        run: { cancelled: run.cancelled, failed: run.failed, statuses: status(run.results) },
        journaled: Object.fromEntries(Object.entries(journal).map(([n, e]) => [n, e.status])),
        post: status(post.results),
        again: status(again.results),
        calls: calls.map((c) => c.slice(0, 2)),
        stoppedPid: await fs.readText(stop[2]!),
        saved: [...service.entries.keys()],
        groups: rec.groups.map((g) => g.title).filter((t) => t.startsWith("dagactions")),
        summaryTitles: rec.summaries.map((s) => s.split("\n")[0]),
      },
      {
        run: {
          cancelled: true,
          failed: 4,
          statuses: {
            "restore:bun": "done",
            "up:db": "done",
            fast: "done",
            slow: "fail",
            after: "cancelled",
            "save:bun": "cancelled",
            "down:db": "cancelled",
          },
        },
        journaled: {
          "restore:bun": "done",
          "up:db": "done",
          fast: "done",
          slow: "fail",
          after: "cancelled",
          "save:bun": "cancelled",
          "down:db": "cancelled",
        },
        post: { "save:bun": "done", "down:db": "done" },
        again: {},
        calls: [["db", "start"], ["fast"], ["slow"], ["db", "stop"]],
        stoppedPid: "7",
        saved: ["bun-old", "bun-new"],
        groups: [
          "dagactions · recording · ref= · 7 nodes",
          "dagactions · post · 2 of 2 post steps owed",
          "dagactions · post · 0 of 2 post steps owed",
        ],
        summaryTitles: ["## dagactions", "## dagactions · post"],
      },
    );
  });
});
