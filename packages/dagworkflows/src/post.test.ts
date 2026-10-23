import { Graph, settled, type Result } from "@mrmeku/dagraph";
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
  code,
  stdout: "",
  stderr: "",
  output: "",
  ok: code === 0,
});
const statuses = (results: Result[]) => Object.fromEntries(results.map((r) => [r.name, r.status]));

describe("a post", () => {
  test("waits for its main and every node of the run downstream of it, through other nodes too, whatever they did, and never for another post of its main; a post of a post waits for that post alone", async () => {
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
        if (program !== "logs") events.push(cmd.join(" "));
        return exited(0);
      },
    };
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({ name: "up:db", cmd: ["db", "start"] });
        const seed = workflow.task({ name: "seed", cmd: ["seed"], deps: { db } });
        workflow.task({ name: "e2e", cmd: ["e2e"], deps: { seed } });
        const down = workflow.post({ name: "down:db", main: settled(db), cmd: ["db", "stop"] });
        workflow.post({ name: "logs:db", main: settled(db), cmd: ["logs"] });
        workflow.post({ name: "report", main: down, cmd: ["report"] });
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
        events: ["db start", "seed", "start e2e", "end e2e", "db stop", "report"],
        statuses: {
          "up:db": "done",
          seed: "done",
          e2e: "failed",
          "down:db": "done",
          "logs:db": "done",
          report: "done",
        },
        waits: {
          "down:db": { deps: ["up:db", "seed", "e2e"], settled: ["up:db", "seed", "e2e"] },
          "logs:db": { deps: ["up:db", "seed", "e2e"], settled: ["up:db", "seed", "e2e"] },
          report: { deps: ["down:db"], settled: [] },
        },
      },
    );
  });

  test("of a settled main runs after the main failed, its outputs unset in env and undefined in an action; a post whose main must succeed is skipped", async () => {
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
        const db = workflow.task({
          name: "up:db",
          cmd: ({ out }) => ["compose", "up", out.id],
          outputs: { id: "id" },
        });
        workflow.post({
          name: "down:db",
          main: settled(db),
          shell: 'if [ -n "${ID+set}" ]; then docker rm -f "$(cat "$ID")"; fi',
          env: ({ main }) => ({ ID: main.id, MODE: "ci" }),
        });
        workflow.post({
          name: "inspect:db",
          main: settled(db),
          action: ({ depOutputs, log }) => log(depOutputs.main ? "db up" : "no db"),
        });
        workflow.post({ name: "stop:db", main: db, cmd: ["stop"] });
      },
    });
    const { results } = await runWorkflow({
      implementation,
      ports,
      casBaseDir: CAS,
      historyDir: HISTORY_DIR,
    });
    const inspect = results.find((r) => r.name === "inspect:db");
    assert.deepEqual(
      {
        statuses: statuses(results),
        envs,
        inspectLog: inspect && (await fs.readText(logPath(CAS, inspect.actionKey))),
      },
      {
        statuses: {
          "up:db": "failed",
          "down:db": "done",
          "inspect:db": "done",
          "stop:db": "dep-failed",
        },
        envs: { compose: {}, bash: { ID: undefined, MODE: "ci" } },
        inspectLog: "no db\n",
      },
    );
  });

  test("waits for a post of another main downstream of its own, as one that still uses its service", async () => {
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
        const db = workflow.task({ name: "up:db", cmd: ["db", "start"] });
        const test = workflow.task({ name: "test", cmd: ["test"], deps: { db } });
        workflow.post({ name: "down:db", main: settled(db), cmd: ["db", "stop"] });
        workflow.post({ name: "dump", main: settled(test), deps: { db }, cmd: ["db", "dump"] });
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

  test("never waits for the other posts of its main, or for their posts", async () => {
    const { ports } = createTestPorts();
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({ name: "up:db", cmd: ["db", "start"] });
        workflow.task({ name: "test", cmd: ["test"], deps: { db } });
        const down = workflow.post({ name: "down:db", main: settled(db), cmd: ["db", "stop"] });
        workflow.post({ name: "report", main: down, cmd: ["report"] });
        const logs = workflow.post({ name: "logs:db", main: settled(db), cmd: ["logs"] });
        workflow.post({ name: "upload:logs", main: logs, cmd: ["upload"] });
      },
    });
    const graph = new Graph<Ports>();
    await implementation(graph, ports, await ports.host.context());
    const posts = postNodes(graph);
    assert.deepEqual(
      Object.fromEntries(
        selectNodes(graph)
          .describe()
          .filter((node) => posts.has(node.name))
          .map((node) => [node.name, node.deps]),
      ),
      {
        "down:db": ["up:db", "test"],
        report: ["down:db"],
        "logs:db": ["up:db", "test"],
        "upload:logs": ["logs:db"],
      },
    );
  });

  test("of a main upstream of another's runs after the other's posts, as GitHub runs posts in the reverse order of their mains", async () => {
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
        const cas = workflow.task({ name: "cas", cmd: ["cas", "restore"] });
        const db = workflow.task({ name: "up:db", cmd: ["db", "start"], deps: { cas } });
        const test = workflow.task({ name: "test", cmd: ["test"], deps: { cas, db } });
        const all = workflow.requireAll({ deps: { test } });
        workflow.post({
          name: "save",
          main: settled(cas),
          deps: { all: settled(all) },
          cmd: ["cas", "save"],
        });
        workflow.post({ name: "down:db", main: settled(db), cmd: ["db", "stop"] });
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

  test("of an action has its name as its kind, so two on one main have keys and logs of their own; a post of a command has the kind post", async () => {
    const { ports } = createTestPorts();
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const db = workflow.task({ name: "up:db", cmd: ["db", "start"] });
        workflow.post({ name: "down", main: db, action: ({ log }) => log("down") });
        workflow.post({ name: "dump", main: db, action: ({ log }) => log("dump") });
        workflow.post({ name: "stop", main: db, cmd: ["db", "stop"] });
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
        kinds: { "up:db": "run", down: "down", dump: "dump", stop: "post" },
        down: "down\n",
        dump: "dump\n",
      },
    );
  });

  test("is refused, with the others, when posts would wait for each other", async () => {
    const { ports } = createTestPorts();
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const a = workflow.task({ name: "a", cmd: ["a"] });
        const b = workflow.task({ name: "b", cmd: ["b"] });
        workflow.post({ name: "p", main: a, deps: { b }, cmd: ["p"] });
        workflow.post({ name: "q", main: b, deps: { a }, cmd: ["q"] });
      },
    });
    await assert.rejects(
      runWorkflow({ implementation, ports, casBaseDir: CAS, historyDir: HISTORY_DIR }),
      {
        message:
          'posts "p" and "q" wait for each other: a post waits for every node downstream of its ' +
          "main, and each is downstream of another's main, neither main upstream of the other. " +
          "Make one a task, which waits only for the deps it names: " +
          'workflow.task({ name: "p", deps: { main: a, ...deps }, cmd }).',
      },
    );
  });

  test("that would wait for each other names the form of the post it would make a task: a cache's save is an action", async () => {
    const { ports } = createTestPorts();
    const { implementation } = defineWorkflow({
      implementation: (workflow) => {
        const cas = workflow.cache({ name: "cas", path: [".cas"], key: "cas-1" });
        const db = workflow.task({ name: "db", cmd: ["db"] });
        const lint = workflow.task({ name: "lint", cmd: ["lint"], deps: { cas: cas.restore } });
        const e2e = workflow.task({ name: "e2e", cmd: ["e2e"], deps: { db } });
        cas.save({ deps: { e2e } });
        workflow.post({ name: "down", main: db, deps: { lint }, cmd: ["down"] });
      },
    });
    await assert.rejects(
      runWorkflow({ implementation, ports, casBaseDir: CAS, historyDir: HISTORY_DIR }),
      {
        message:
          'posts "save:cas" and "down" wait for each other: a post waits for every node downstream ' +
          "of its main, and each is downstream of another's main, neither main upstream of the " +
          "other. Make one a task, which waits only for the deps it names: " +
          'workflow.task({ name: "save:cas", deps: { main: main, ...deps }, action }).',
      },
    );
  });
});
