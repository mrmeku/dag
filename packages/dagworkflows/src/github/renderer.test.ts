import { file, settled } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { errorMessage } from "../kernel/format.ts";
import type { ExecResult } from "../ports.ts";
import { createTestPorts } from "../ports/memory.ts";
import { runWorkflow } from "../runner.ts";
import { renderFailures, renderStatus, renderTimeline } from "../summary.ts";
import { defineWorkflow } from "../workflow.ts";
import { createGithubStore } from "./renderer.ts";

const exited = (code: number, output: string): ExecResult => {
  return { ended: "exited", code, stdout: output, stderr: "", output, ok: code === 0 };
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
          "✖︎ lint failed · ci.ts · built 0 · cached 0 · failed 1 · skipped 0 · cancelled 2 · wall 6.0s",
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

  test("a node the cancel caught queued is a line, not a group, and its check run never started: it looked its key up but never ran", async () => {
    let started = () => {};
    const slowStarted = new Promise<void>((resolve) => (started = resolve));
    const { ports, rec } = createTestPorts({
      exec: {
        run: async (_cmd, opts) => {
          started();
          const signal = opts?.signal;
          if (!signal) throw new Error("slow ran without a signal");
          return new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve(exited(130, "compiling\n"))),
          );
        },
      },
    });
    const schedulerOptions = { concurrencyLimits: { one: 1 } };
    const { implementation } = defineWorkflow({
      schedulerOptions,
      implementation: (workflow) => {
        for (const name of ["slow", "queued"])
          workflow.task({ name, cmd: [name], concurrencyGroup: "one", cacheable: false });
      },
    });
    const controller = new AbortController();
    const running = runWorkflow({
      implementation,
      schedulerOptions,
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
        log: rec.log.slice(1, 4),
        startedChecks: rec.checks.flatMap((check) => (check.startedAt ? [check.name] : [])),
      },
      {
        log: [
          "▷ slow",
          "◼︎ queued: cancelled",
          { title: "◼︎ slow (cancelled)", lines: ["compiling"] },
        ],
        startedChecks: ["slow", "slow"],
      },
    );
  });

  test("a task whose key needs a missing file fails before it starts: no start line, start time or duration, and the summary counts it as no run", async () => {
    const { ports, rec } = createTestPorts();
    const workflowDef = defineWorkflow({
      summary: [renderStatus, renderTimeline, renderFailures],
      implementation: (workflow) =>
        void workflow.task({
          name: "lint",
          cmd: ["lint"],
          inputs: { "src/a.ts": file("src/a.ts") },
        }),
    });
    await runWorkflow({
      ...workflowDef,
      workflowFile: "ci.ts",
      ports,
      casBaseDir: "/cas",
      historyDir: "/history",
    });
    const error = "ENOENT: src/a.ts";
    assert.deepEqual(
      { log: rec.log, checks: rec.checks, summary: rec.summaries.join("").split("\n") },
      {
        log: [
          { title: "ci.ts · 1 node", lines: ["lint"] },
          { title: "✖︎ lint (not started)", lines: ["── error ──", error] },
          "",
          "✖︎ lint failed · ci.ts · built 0 · cached 0 · failed 1 · skipped 0 · wall 0ms",
          "failed: lint",
          "reproduce: npx --no dag run ci.ts --only lint",
        ],
        checks: [
          {
            name: "lint",
            status: "completed",
            conclusion: "failure",
            completedAt: "1970-01-01T00:00:01.000Z",
            summary: error,
          },
        ],
        // No timeline and no parallelism: nothing ran.
        summary: [
          "## ci.ts",
          "",
          "### ✖︎ lint failed",
          "",
          "built **0** · cached **0** · failed **1** · skipped **0** · wall 0ms",
          "",
          "### failures",
          "",
          "<details><summary>✖︎ lint (not started)</summary>",
          "",
          "```text",
          "── error ──",
          error,
          "```",
          "",
          "</details>",
          "",
        ],
      },
    );
  });

  test("a task whose start the run's history cannot record shows its start, then fails not started, and the run rejects with the write's error", async () => {
    const { ports, rec } = createTestPorts();
    const writeText = ports.fs.writeText;
    ports.fs.writeText = (path, text) =>
      path.startsWith("/history/") && text.includes('"lint"')
        ? Promise.reject(new Error("disk full"))
        : writeText(path, text);
    const store = createGithubStore(ports, "/cas");
    const { implementation } = defineWorkflow({
      implementation: (workflow) => void workflow.task({ name: "lint", cmd: ["lint"] }),
    });
    const error = await runWorkflow({
      implementation,
      workflowFile: "ci.ts",
      ports,
      casBaseDir: "/cas",
      historyDir: "/history",
      store,
    }).catch(errorMessage);
    await store.close(error);
    assert.deepEqual(
      { error, log: rec.log, checks: rec.checks },
      {
        error: "disk full",
        log: [
          { title: "ci.ts · 1 node", lines: ["lint"] },
          "▷ lint",
          { title: "✖︎ lint (not started)", lines: ["── error ──", "disk full"] },
        ],
        checks: [
          { name: "lint", status: "in_progress", startedAt: "1970-01-01T00:00:01.000Z" },
          {
            name: "lint",
            status: "completed",
            conclusion: "failure",
            completedAt: "1970-01-01T00:00:02.000Z",
            summary: "disk full",
          },
        ],
      },
    );
  });

  test("the reproduce line quotes a name the shell would split", async () => {
    const { ports, rec } = createTestPorts({
      exec: { run: async (cmd) => exited(1, `${cmd[0]}\n`) },
    });
    const { implementation } = defineWorkflow({
      implementation: (workflow) =>
        void workflow.task({ name: "lint docs", cmd: ["lint"], cacheable: false }),
    });
    await runWorkflow({
      implementation,
      workflowFile: "ci.ts",
      ports,
      casBaseDir: "/cas",
      historyDir: "/history",
    });
    assert.equal(rec.log.at(-1), "reproduce: npx --no dag run ci.ts --only 'lint docs'");
  });

  test("a failed post, a failed save and requireAll beside a failed check: each in the headline, the summary and the reproduce line", async () => {
    const { ports, rec, cacheStore } = createTestPorts({
      exec: { run: async (cmd) => exited(cmd[0] === "up" ? 0 : 1, `${cmd[0]}\n`) },
    });
    // The save, an ordinary task now, fails for its own reason after the check it waits for.
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
          "✖︎ test, require-all, down:db and 1 more failed · ci.ts · built 2 · cached 0 · failed 4 · skipped 0 · wall 25.0s",
          "failed: test, require-all, down:db, save:cas",
          "reproduce: npx --no dag run ci.ts --only test,require-all,down:db,save:cas",
        ],
        summary: "### ✖︎ test, require-all, down:db and 1 more failed",
      },
    );
  });
});
