import {
  createMemoryFileSystem,
  execute,
  Graph,
  resultActionKey,
  type ExecuteOptions,
  type NodeResult,
} from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { manualTimer, okExec } from "../memory/index.ts";
import { addTask, type Clock, type Exec, type ExecResult, type TaskPorts } from "./index.ts";

const CACHE_DIR = "/cache";
const exited = (code: number): ExecResult => ({
  ended: "exited",
  code,
  stdout: "",
  stderr: "",
  output: "",
  ok: code === 0,
});
/** A clock that records each sleep, which ends at once, or with `waiting` only when its signal fires. */
function recordingClock(waiting = false) {
  const sleeps: number[] = [];
  const clock: Clock = {
    epochMilliseconds: () => 0,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      if (waiting)
        await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
    },
  };
  return { clock, sleeps };
}
const portsOf = (exec: Exec, clock = recordingClock().clock): TaskPorts => ({
  exec,
  clock,
  fs: createMemoryFileSystem(),
});
/** Executes `graph` with dagraph's `execute`: each node's result and what it printed, by name. */
async function executeTasks(
  graph: Graph<TaskPorts>,
  ports: TaskPorts,
  options: ExecuteOptions = {},
) {
  const printed = new Map<string, string>();
  const results = await execute(
    graph,
    { ports, fs: ports.fs, clock: ports.clock, startTimer: manualTimer(), cacheDir: CACHE_DIR },
    {
      ...options,
      onEvent: (event) => {
        if (event.type === "output")
          printed.set(event.node, (printed.get(event.node) ?? "") + event.chunk);
      },
    },
  );
  return { results: new Map(results.map((r) => [r.name, r])), printed };
}
/** How a node settled, in the words the run's output uses: built or cached, or its status. */
const outcomeOf = (result: NodeResult) =>
  result.status === "succeeded" ? (result.details.actionRan ? "built" : "cached") : result.status;
const statuses = (results: Map<string, NodeResult>) =>
  Object.fromEntries([...results].map(([name, r]) => [name, outcomeOf(r)]));

describe("a post", () => {
  test("runs after its task failed, its task's outputs unset in env and undefined in an action", async () => {
    const envs: Record<string, Record<string, string | undefined> | undefined> = {};
    const ports = portsOf({
      run: async ([program = ""], opts) => {
        envs[program] = opts?.env;
        return exited(program === "compose" ? 1 : 0);
      },
    });
    const graph = new Graph<TaskPorts>();
    addTask(graph, {
      name: "up:db",
      cmd: ({ out }) => ["compose", "up", out.id],
      outputs: { id: "id" },
      post: {
        name: "down:db",
        shell: 'if [ -n "${ID+set}" ]; then docker rm -f "$(cat "$ID")"; fi',
        env: ({ main }) => ({ ID: main.id, MODE: "ci" }),
      },
    });
    addTask(graph, {
      name: "up:queue",
      cmd: ({ out }) => ["compose", "queue", out.id],
      outputs: { id: "id" },
      post: {
        name: "inspect:queue",
        action: ({ depOutputs, log }) => log(depOutputs.main ? "queue up" : "no queue"),
      },
    });
    const { results, printed } = await executeTasks(graph, ports);
    assert.deepEqual(
      { statuses: statuses(results), envs, inspectLog: printed.get("inspect:queue") },
      {
        statuses: {
          "up:db": "failed",
          "up:queue": "failed",
          "down:db": "built",
          "inspect:queue": "built",
        },
        envs: { compose: {}, bash: { ID: undefined, MODE: "ci" } },
        inspectLog: "no queue\n",
      },
    );
  });

  test("of an action has its name as its kind, so two have keys of their own; a post of a command has the kind post", async () => {
    const graph = new Graph<TaskPorts>();
    addTask(graph, {
      name: "up:db",
      cmd: ["db", "start"],
      post: { name: "down", action: ({ log }) => log("down") },
    });
    addTask(graph, {
      name: "up:queue",
      cmd: ["queue", "start"],
      post: { name: "dump", action: ({ log }) => log("dump") },
    });
    addTask(graph, {
      name: "up:cache",
      cmd: ["cache", "start"],
      post: { name: "stop", cmd: ["cache", "stop"] },
    });
    const { results } = await executeTasks(graph, portsOf(okExec));
    const keyOf = (name: string) => {
      const result = results.get(name);
      return result && resultActionKey(result);
    };
    assert.deepEqual(
      {
        kinds: Object.fromEntries(graph.describe().map((n) => [n.name, n.kind])),
        keysOfTheirOwn: keyOf("down") !== keyOf("dump"),
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
        keysOfTheirOwn: true,
      },
    );
  });

  test("depends settled on its task and requires what its task requires, so it is skipped when its task never started", async () => {
    const ports = portsOf({ run: async ([program]) => exited(program === "pull" ? 1 : 0) });
    const graph = new Graph<TaskPorts>();
    const image = addTask(graph, { name: "pull", cmd: ["pull"] });
    const lint = addTask(graph, { name: "lint", cmd: ["lint"] });
    addTask(graph, {
      name: "up:db",
      cmd: ["db", "start"],
      deps: { image, lint },
      post: { name: "down:db", cmd: ["db", "stop"] },
    });
    const { results } = await executeTasks(graph, ports);
    const post = graph.describe().find((node) => node.name === "down:db");
    assert.deepEqual(
      {
        deps: post && { deps: post.deps, settled: post.settledDeps },
        statuses: statuses(results),
      },
      {
        deps: { deps: ["up:db", "pull", "lint"], settled: ["up:db"] },
        statuses: { pull: "failed", lint: "built", "up:db": "dep-failed", "down:db": "dep-failed" },
      },
    );
  });

  test("tries again after 1,000 then 4,000 ms with backoff, in one output directory, and tries once with retry once", async () => {
    const { clock, sleeps } = recordingClock();
    let tries = 0;
    const outputDirs = new Set<string>();
    const ports = portsOf(
      {
        run: async ([program]) => {
          if (program !== "release") return exited(program === "refuse" ? 1 : 0);
          tries++;
          return exited(tries < 3 ? 1 : 0);
        },
      },
      clock,
    );
    const graph = new Graph<TaskPorts>();
    addTask(graph, {
      name: "up:db",
      cmd: ["db", "start"],
      post: {
        name: "down:db",
        action: async ({ outputDir, run }) => {
          outputDirs.add(outputDir);
          await run(["release"]);
        },
      },
    });
    addTask(graph, {
      name: "up:infra",
      cmd: ["infra", "up"],
      post: { name: "destroy", cmd: ["refuse"], retry: "once" },
    });
    const { results, printed } = await executeTasks(graph, ports);
    const destroy = results.get("destroy");
    assert.deepEqual(
      {
        statuses: statuses(results),
        tries,
        outputDirs: outputDirs.size,
        sleeps,
        log: printed.get("down:db"),
        destroy: destroy?.status === "failed" && destroy.error.message,
      },
      {
        statuses: { "up:db": "built", "down:db": "built", "up:infra": "built", destroy: "failed" },
        tries: 3,
        outputDirs: 1,
        sleeps: [1000, 4000],
        log:
          "Try 1 of 3 failed: release exited 1. Trying again in 1000 ms.\n" +
          "Try 2 of 3 failed: release exited 1. Trying again in 4000 ms.\n",
        destroy: "refuse exited 1",
      },
    );
  });

  test("that fails every try fails with its last try's error", async () => {
    const { clock, sleeps } = recordingClock();
    let tries = 0;
    const ports = portsOf(
      { run: async ([program]) => (program === "db" ? exited(0) : exited(++tries)) },
      clock,
    );
    const graph = new Graph<TaskPorts>();
    addTask(graph, {
      name: "up:db",
      cmd: ["db", "start"],
      post: { name: "down:db", cmd: ["release"] },
    });
    const { results, printed } = await executeTasks(graph, ports);
    const post = results.get("down:db");
    assert.deepEqual(
      {
        failure: post?.status === "failed" && post.error.message,
        sleeps,
        log: printed.get("down:db"),
      },
      {
        failure: "release exited 3",
        sleeps: [1000, 4000],
        log:
          "Try 1 of 3 failed: release exited 1. Trying again in 1000 ms.\n" +
          "Try 2 of 3 failed: release exited 2. Trying again in 4000 ms.\n",
      },
    );
  });

  test("cancelled during a try tries no more, and neither logs a try nor waits", async () => {
    const { clock, sleeps } = recordingClock();
    let tries = 0;
    const ports = portsOf(
      {
        run: async ([program], opts) => {
          if (program === "db") return exited(0);
          tries++;
          // The release runs until the signal fires, then exits 1.
          return new Promise((resolve) =>
            opts?.signal?.addEventListener("abort", () => resolve(exited(1)), { once: true }),
          );
        },
      },
      clock,
    );
    const graph = new Graph<TaskPorts>();
    addTask(graph, {
      name: "up:db",
      cmd: ["db", "start"],
      post: { name: "down:db", cmd: ["release"] },
    });
    const cancel = new AbortController();
    const executed = executeTasks(graph, ports, { signal: cancel.signal });
    while (tries === 0) await new Promise((resolve) => setImmediate(resolve));
    cancel.abort();
    const { results, printed } = await executed;
    assert.deepEqual(
      { status: results.get("down:db")?.status, tries, sleeps, log: printed.get("down:db") },
      { status: "cancelled", tries: 1, sleeps: [], log: undefined },
    );
  });

  test("cancelled while it waits to try again tries no more", async () => {
    const { clock, sleeps } = recordingClock(true);
    let tries = 0;
    const ports = portsOf(
      { run: async ([program]) => (program === "db" ? exited(0) : (tries++, exited(1))) },
      clock,
    );
    const graph = new Graph<TaskPorts>();
    addTask(graph, {
      name: "up:db",
      cmd: ["db", "start"],
      post: { name: "down:db", cmd: ["release"] },
    });
    const cancel = new AbortController();
    const executed = executeTasks(graph, ports, { signal: cancel.signal });
    while (sleeps.length === 0) await new Promise((resolve) => setImmediate(resolve));
    cancel.abort();
    assert.deepEqual(
      { statuses: statuses((await executed).results), tries, sleeps },
      { statuses: { "up:db": "built", "down:db": "cancelled" }, tries: 1, sleeps: [1000] },
    );
  });

  test("given outputs is refused before its task is added", () => {
    const graph = new Graph<TaskPorts>();
    const refused = (() => {
      try {
        addTask(graph, {
          name: "up:db",
          cmd: ["db", "start"],
          // @ts-expect-error a post step has no outputs
          post: { name: "down:db", cmd: ["db", "stop"], outputs: { log: "log.txt" } },
        });
        return "accepted";
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    })();
    assert.deepEqual(
      { refused, nodes: graph.describe().map((node) => node.name) },
      {
        refused:
          'post "down:db" of task "up:db": a post step has no outputs. Write what it leaves to the working tree.',
        nodes: [],
      },
    );
  });
});
