import { settled } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExecResult } from "../ports.ts";
import { createTestPorts } from "../ports/memory.ts";
import { runWorkflow } from "../runner.ts";
import { defineWorkflow } from "../workflow.ts";

const exited = (code: number, output: string): ExecResult => {
  return { code, stdout: output, stderr: "", output, ok: code === 0 };
};

describe("GitHub renderer", () => {
  test("a failure, then a cancel, as the job shows them", async () => {
    let started = () => {};
    const slowStarted = new Promise<void>((resolve) => (started = resolve));
    const { ports, rec } = createTestPorts({
      exec: {
        run: async (cmd, opts) => {
          if (cmd[0] === "lint") return exited(1, "src/a.ts: error\n");
          started();
          const signal = opts?.signal;
          if (!signal) throw new Error(`${cmd.join(" ")} ran without a signal`);
          return new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve(exited(-1, "compiling\n"))),
          );
        },
      },
    });
    // The checks API answers after the log has moved on.
    rec.host.check = async (update) => {
      await new Promise(setImmediate);
      rec.checks.push(update);
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const lint = workflow.task({ name: "lint", cmd: ["lint"], cacheable: false });
        const slow = workflow.task({
          name: "slow",
          cmd: ["slow"],
          deps: { lint: settled(lint) },
          cacheable: false,
        });
        workflow.task({ name: "after", cmd: ["after"], deps: { slow } });
      },
    });
    const controller = new AbortController();
    const running = runWorkflow({
      implementation,
      workflowFile: "ci.ts",
      ports,
      casBaseDir: "/cas",
      historyDir: "/history",
      signal: controller.signal,
    });
    await slowStarted;
    controller.abort();
    await running;
    assert.deepEqual(
      {
        log: rec.log,
        checks: rec.checks.map(
          (checkRun) => `${checkRun.name} ${checkRun.conclusion ?? checkRun.status}`,
        ),
      },
      {
        log: [
          { title: "ci.ts · 3 nodes", lines: ["lint", "slow", "after"] },
          "▷ lint",
          {
            title: "✖︎ lint (1.0s)",
            lines: ["src/a.ts: error", "── error ──", "lint exited 1"],
          },
          "▷ slow",
          { title: "◼︎ slow (cancelled)", lines: ["compiling"] },
          "◼︎ after: cancelled",
          "",
          "✖︎ lint failed · ci.ts · built 0 · cached 0 · failed 1 · skipped 0 · cancelled 2 · wall 4.0s",
          "failed: lint",
          "cancelled: slow, after",
          "reproduce: npx --no dag run ci.ts --only lint",
        ],
        checks: [
          "lint in_progress",
          "slow in_progress",
          "lint failure",
          "slow cancelled",
          "after cancelled",
        ],
      },
    );
  });

  test("a failed post beside a failed check: both in the headline, the summary and the reproduce line, and requireAll and the cache save under their deps", async () => {
    const { ports, rec, cacheStore } = createTestPorts({
      exec: { run: async (cmd) => exited(cmd[0] === "up" ? 0 : 1, `${cmd[0]}\n`) },
    });
    // The save, an ordinary task now, fails after the check it waits for.
    cacheStore.save = async () => {
      throw Object.assign(new Error("Key Validation Error: k cannot contain commas."), {
        name: "ValidationError",
      });
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        workflow.cache({ name: "cas", path: [".cas"], key: "k" }).save();
        const db = workflow.task({
          name: "up:db",
          cmd: ["up"],
          post: { name: "down:db", cmd: ["down"], retry: "once" },
        });
        const test = workflow.task({ name: "test", cmd: ["test"], deps: { db } });
        workflow.requireAll({ deps: { test } });
      },
    });
    await runWorkflow({
      implementation,
      workflowFile: "ci.ts",
      ports,
      casBaseDir: "/cas",
      historyDir: "/history",
    });
    assert.deepEqual(
      {
        recap: rec.log.slice(-3),
        summary: rec.summaries
          .join("")
          .split("\n")
          .find((line) => line.startsWith("### ")),
      },
      {
        recap: [
          "✖︎ test, down:db failed · ci.ts · built 2 · cached 0 · failed 4 · skipped 0 · wall 15.0s",
          "failed: test, require-all, down:db, save:cas",
          "reproduce: npx --no dag run ci.ts --only test,down:db",
        ],
        summary: "### ✖︎ test, down:db failed",
      },
    );
  });
});
