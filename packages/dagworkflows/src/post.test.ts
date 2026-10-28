import { Graph, type Result } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExecResult, Ports } from "./ports.ts";
import { createTestPorts } from "./ports/memory.ts";
import { runWorkflow } from "./runner.ts";
import { selectNodes } from "./select.ts";
import { logPath } from "./step-records.ts";
import { postNodes } from "./steps.ts";
import { defineWorkflow } from "./workflow.ts";

const CAS = "/cas";
const HISTORY_DIR = "/state/history";
const exited = (code: number): ExecResult => ({
  ended: "exited",
  code,
  stdout: "",
  stderr: "",
  output: "",
  ok: code === 0,
});
const statuses = (results: Result[]) => Object.fromEntries(results.map((r) => [r.name, r.status]));

describe("a post", () => {
  test("waits for its task and every node of the run downstream of it, through other nodes too, whatever they did", async () => {
    const { ports } = createTestPorts();
    const events: string[] = [];
    ports.exec = {
      run: async (cmd) => {
        const [program] = cmd;
        if (program === "e2e") {
          events.push("start e2e");
          await new Promise((r) => setTimeout(r, 50));
          events.push("end e2e");
          return exited(1);
        }
        events.push(cmd.join(" "));
        return exited(0);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({
          name: "up:db",
          cmd: ["db", "start"],
          post: { name: "down:db", cmd: ["db", "stop"] },
        });
        const seed = workflow.task({ name: "seed", cmd: ["seed"], deps: { db } });
        workflow.task({ name: "e2e", cmd: ["e2e"], deps: { seed } });
      },
    });
    const graph = new Graph<Ports>();
    await implementation(graph, ports, await ports.host.context());
    const posts = postNodes(graph);
    const { results } = await runWorkflow({
      implementation,
      ports,
      casBaseDir: CAS,
      historyDir: HISTORY_DIR,
    });
    assert.deepEqual(
      {
        events,
        statuses: statuses(results),
        waits: Object.fromEntries(
          selectNodes(graph)
            .describe()
            .filter((node) => posts.has(node.name))
            .map((node) => [node.name, { deps: node.deps, settled: node.settledDeps ?? [] }]),
        ),
      },
      {
        events: ["db start", "seed", "start e2e", "end e2e", "db stop"],
        statuses: { "up:db": "done", seed: "done", e2e: "failed", "down:db": "done" },
        waits: {
          "down:db": { deps: ["up:db", "seed", "e2e"], settled: ["up:db", "seed", "e2e"] },
        },
      },
    );
  });

  test("runs after its task failed, its task's outputs unset in env and undefined in an action", async () => {
    const { ports, fs } = createTestPorts();
    const envs: Record<string, Record<string, string | undefined> | undefined> = {};
    ports.exec = {
      run: async (cmd, opts) => {
        const [program = ""] = cmd;
        envs[program] = opts?.env;
        return exited(program === "compose" ? 1 : 0);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        workflow.task({
          name: "up:db",
          cmd: ({ out }) => ["compose", "up", out.id],
          outputs: { id: "id" },
          post: {
            name: "down:db",
            shell: 'if [ -n "${ID+set}" ]; then docker rm -f "$(cat "$ID")"; fi',
            env: ({ main }) => ({ ID: main.id, MODE: "ci" }),
          },
        });
        workflow.task({
          name: "up:queue",
          cmd: ({ out }) => ["compose", "queue", out.id],
          outputs: { id: "id" },
          post: {
            name: "inspect:queue",
            action: ({ depOutputs, log }) => log(depOutputs.main ? "queue up" : "no queue"),
          },
        });
      },
    });
    const { results } = await runWorkflow({
      implementation,
      ports,
      casBaseDir: CAS,
      historyDir: HISTORY_DIR,
    });
    const inspect = results.find((r) => r.name === "inspect:queue");
    assert.deepEqual(
      {
        statuses: statuses(results),
        envs,
        inspectLog: inspect && (await fs.readText(logPath(CAS, inspect.actionKey))),
      },
      {
        statuses: {
          "up:db": "failed",
          "up:queue": "failed",
          "down:db": "done",
          "inspect:queue": "done",
        },
        envs: { compose: {}, bash: { ID: undefined, MODE: "ci" } },
        inspectLog: "no queue\n",
      },
    );
  });

  test("waits for the post of a task downstream of its own, as one that still uses its service", async () => {
    const { ports } = createTestPorts();
    const calls: string[] = [];
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        return exited(0);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({
          name: "up:db",
          cmd: ["db", "start"],
          post: { name: "down:db", cmd: ["db", "stop"] },
        });
        workflow.task({
          name: "test",
          cmd: ["test"],
          deps: { db },
          post: { name: "dump", cmd: ["db", "dump"] },
        });
      },
    });
    const { results } = await runWorkflow({
      implementation,
      ports,
      casBaseDir: CAS,
      historyDir: HISTORY_DIR,
    });
    assert.deepEqual(
      { calls, statuses: statuses(results) },
      {
        calls: ["db start", "test", "db dump", "db stop"],
        statuses: { "up:db": "done", test: "done", dump: "done", "down:db": "done" },
      },
    );
  });

  test("of a task upstream of another's runs after the other's post, as GitHub runs posts in the reverse order of their mains", async () => {
    const { ports } = createTestPorts();
    const calls: string[] = [];
    ports.exec = {
      run: async (cmd) => {
        calls.push(cmd.join(" "));
        return exited(0);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const cas = workflow.task({
          name: "cas",
          cmd: ["cas", "restore"],
          post: { name: "save", cmd: ["cas", "save"] },
        });
        const db = workflow.task({
          name: "up:db",
          cmd: ["db", "start"],
          deps: { cas },
          post: { name: "down:db", cmd: ["db", "stop"] },
        });
        const test = workflow.task({ name: "test", cmd: ["test"], deps: { cas, db } });
        workflow.requireAll({ deps: { test } });
      },
    });
    const { results } = await runWorkflow({
      implementation,
      ports,
      casBaseDir: CAS,
      historyDir: HISTORY_DIR,
    });
    assert.deepEqual(
      { calls, statuses: statuses(results) },
      {
        calls: ["cas restore", "db start", "test", "db stop", "cas save"],
        statuses: {
          cas: "done",
          "up:db": "done",
          test: "done",
          "require-all": "done",
          "down:db": "done",
          save: "done",
        },
      },
    );
  });

  test("of an action has its name as its kind, so two have keys and logs of their own; a post of a command has the kind post", async () => {
    const { ports } = createTestPorts();
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        workflow.task({
          name: "up:db",
          cmd: ["db", "start"],
          post: { name: "down", action: ({ log }) => log("down") },
        });
        workflow.task({
          name: "up:queue",
          cmd: ["queue", "start"],
          post: { name: "dump", action: ({ log }) => log("dump") },
        });
        workflow.task({
          name: "up:cache",
          cmd: ["cache", "start"],
          post: { name: "stop", cmd: ["cache", "stop"] },
        });
      },
    });
    const graph = new Graph<Ports>();
    await implementation(graph, ports, await ports.host.context());
    const { results } = await runWorkflow({
      implementation,
      ports,
      casBaseDir: CAS,
      historyDir: HISTORY_DIR,
    });
    const logOf = async (name: string) => {
      const result = results.find((r) => r.name === name);
      return result && (await ports.fs.readText(logPath(CAS, result.actionKey)));
    };
    assert.deepEqual(
      {
        kinds: Object.fromEntries(graph.describe().map((n) => [n.name, n.kind])),
        down: await logOf("down"),
        dump: await logOf("dump"),
      },
      {
        kinds: {
          "up:db": "run",
          down: "down",
          "up:queue": "run",
          dump: "dump",
          "up:cache": "run",
          stop: "post",
        },
        down: "down\n",
        dump: "dump\n",
      },
    );
  });
});
