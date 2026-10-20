import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ShResult } from "../ports.ts";
import { createTestPorts } from "../ports/memory.ts";
import { runWorkflow } from "../runner.ts";
import { defineWorkflow } from "../workflow.ts";

const exited = (code: number, output: string): ShResult => {
  return { code, stdout: output, stderr: "", output, ok: code === 0 };
};

describe("GitHub renderer", () => {
  test("a failure, then a cancel, as the job shows them", async () => {
    let started = () => {};
    const slowStarted = new Promise<void>((resolve) => (started = resolve));
    const { ports, rec } = createTestPorts({
      sh: {
        run: async (cmd, opts) => {
          if (cmd[0] === "lint") return exited(1, "src/a.ts: error\n");
          started();
          return new Promise((resolve) =>
            opts!.signal!.addEventListener("abort", () => resolve(exited(-1, "compiling\n"))),
          );
        },
      },
    });
    // The checks API answers after the log has moved on.
    rec.ci.check = async (update) => {
      await new Promise(setImmediate);
      rec.checks.push(update);
    };
    const { workflow } = defineWorkflow({
      build: (w) => {
        const lint = w.run({ name: "lint", cmd: ["lint"], cacheable: false });
        const slow = w.run({
          name: "slow",
          cmd: ["slow"],
          deps: { lint: w.settled(lint) },
          cacheable: false,
        });
        w.run({ name: "after", cmd: ["after"], deps: { slow } });
      },
    });
    const controller = new AbortController();
    const running = runWorkflow({
      workflow,
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
          { title: "✖︎ lint (1.0s)", lines: ["src/a.ts: error", "── error ──", "lint exited 1"] },
          "▷ slow",
          { title: "◼︎ slow (cancelled)", lines: ["compiling"] },
          "◼︎ after: cancelled",
          "",
          "✖︎ lint failed · ci.ts · built 0 · cached 0 · failed 1 · skipped 0 · cancelled 2 · wall 4.0s",
          "failed: lint",
          "cancelled: slow, after",
          "reproduce: npx dagactions run ci.ts --only lint",
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
});
