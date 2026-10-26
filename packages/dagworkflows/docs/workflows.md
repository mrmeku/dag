# Write a workflow

This page takes a workflow file past the [quick start](../README.md#quick-start). A workflow file default-exports `defineWorkflow({ implementation })`. The implementation gets a `workflow` object and only describes nodes. It runs before any node starts, and again when dag pays owed [post steps](#post-steps), so it must be a pure description that runs no commands. Conditional work is plain code over `workflow.ctx`, such as `if (workflow.ctx.ref === "refs/heads/main")`. A task has no `if:` field.

Here is one workflow that uses most of it, in a git repository holding `src/a.ts` and `src/b.txt`:

```ts
import { defineWorkflow, settled } from "@mrmeku/dagworkflows";

export default defineWorkflow({
  schedulerOptions: { maxParallelism: 2, concurrencyLimits: { test: 1 } },
  implementation: async (workflow) => {
    const src = await workflow.glob("src/**");
    const pack = workflow.task({
      name: "pack",
      inputs: { version: "pack-v1", ...src },
      outputs: { tarball: "src.tgz" },
      cmd: ({ out }) => ["tar", "-czf", out.tarball, "src"],
    });
    const list = workflow.task({
      name: "list",
      deps: { pack },
      inputs: { version: "list-v1" },
      outputs: { listing: "listing.txt" },
      shell: 'tar -tzf "$TARBALL" | sort > "$OUT"',
      env: ({ pack, out }) => ({ TARBALL: pack.tarball, OUT: out.listing }),
    });
    const count = workflow.task({
      name: "count",
      deps: { list },
      inputs: { version: "count-v1" },
      outputs: { count: "count.txt" },
      concurrencyGroup: "test",
      action: async ({ depOutputs, out, ports, log }) => {
        const n = (await depOutputs.list.listing.text()).trim().split("\n").length;
        log(`${n} entries`);
        await ports.fs.writeText(out.count, String(n));
      },
    });
    const flaky = workflow.task({ name: "flaky", shell: "exit 3", outputs: { report: "r.txt" } });
    workflow.task({
      name: "report",
      deps: { flaky: settled(flaky) },
      shell: 'if [ -n "${REPORT+set}" ]; then echo has; else echo none; fi',
      env: ({ flaky }) => ({ REPORT: flaky.report }),
    });
    workflow.requireAll({ deps: { count, flaky } });
  },
});
```

Run it with `npx --no dag run ci.ts --output-style=grouped`, which prints every node's log. `pack` and `flaky` have no dependencies, so they start together. `flaky` exits 3 and fails. `report` depends on it through `settled`, so it runs anyway and prints `none`. `list` and `count` follow `pack`, and `count` logs `3 entries`. Last, `require-all` fails with `failed: flaky`, and the run exits 1.

Run it again with nothing changed. `pack`, `list` and `count` declared inputs, so they come from the CAS. `flaky` and `report` declared none, so they run again. So does `require-all`, because a failure is never cached.

Now append a line to `src/b.txt` and run `npx --no dag run ci.ts --only count`, which runs `count` and everything it depends on. `pack` rebuilds because a file input changed, and `list` because its dependency's content did. But `list` writes the same listing, so `count` stays cached. A dependent keys on what its dependency wrote, not on whether it ran. That's early cutoff.

The sections below take each part of this workflow in turn.

## Tasks

A task's work is exactly one of three fields. `cmd` is an argv run with no shell, as in `pack`. `shell` is a string run under bash with `-eo pipefail`, so any failing stage of a pipe fails the task. Use it for pipes, as in `list`. `action` is a TypeScript function, which makes `count` a function task.

A function task gets its inputs as `inputs`, its dependencies' outputs as `depOutputs` and its own output paths as `out`. It writes to its log with `log` and `warn`, and reads and writes files with `ports.fs`. It runs commands with `run` and `runShell`: `await run(["tar", "-tzf", path])` runs a program with no shell, and `await runShell('tar -tzf "$TARBALL" | sort', { env: { TARBALL } })` runs a string under bash. Both resolve with stdout and throw on a nonzero exit.

Run a program as a command when you can. A command's line, `cwd` and declared `env` are part of its cache key, so editing the command reruns it with no version to bump. Write a function task for TypeScript logic: reading a dependency's files, using `ports`, or running several programs with decisions in between. Neither its code nor the commands it runs through `run` are in its key, so bump its `version` input whenever either changes.

## Dependencies and outputs

`deps` names each dependency by a role. In `deps: { pack }` the role is `pack`, and that is the name `list` reads it by. A task waits for its dependencies to succeed, whether they ran or came from the CAS. If one fails or is skipped, the task is skipped too.

Tasks pass files through declared outputs. `outputs: { tarball: "src.tgz" }` names a file in the task's own output directory, which moves into the CAS when the task succeeds. An output still missing when the task ends fails it. A dependent reads the file by role. A command reads it through the refs its `cmd` or `env` function receives, such as `pack.tarball`. A function task reads it through a file handle, such as `depOutputs.list.listing`, with `path`, `text()`, `hash()` and `json(guard)`. `json(guard)` checks the parsed value with the type guard you pass.

A ref becomes an absolute path only when the command starts. So it is a whole argument or a whole `env` value, never part of a string. A `shell` string never holds a ref either: pass each path through `env` and read it quoted, as `list` reads `"$TARBALL"`.

`settled(flaky)` waits for the dependency to end however it ends, like GitHub's `always()`. When it did not succeed, its outputs are unset in `env` and `undefined` in `depOutputs`. So test them, as `report` tests `${REPORT+set}`.

## Inputs and when a task runs

`inputs` names what, besides its dependencies, decides a task's result. A file input, `file(path)`, imported from `@mrmeku/dagworkflows`, joins the key with its path as written and its content. You usually spread them from `workflow.glob("src/**")`, which leaves out `.git`, `node_modules` and `.dag`. A value input is JSON. It is a `version` string you bump when a function task's logic changes, or an environment variable read at build time, such as `mixEnv: workflow.ports.env.MIX_ENV ?? null`.

A task is cached exactly when its inputs hold at least one defined value. With none, as `flaky` has, it runs every time. `cacheable: true` caches a task without inputs, and `cacheable: false` runs one with inputs every time.

A cacheable task comes from the CAS when an entry exists for its action key. The key hashes the task's kind, its inputs and its declared `outputs`. For a command it also hashes the line, the `cwd` and the `env` it declares. And it hashes each dependency's content by role. Nothing else joins it: not a function's code, and not the environment a command inherits. So changing a program's source reruns nothing unless its files are inputs. `--force` ignores the CAS for one run. The rest of the contract is in dagraph's [When a node runs again](../../dagraph/docs/caching.md).

## Side effects: receipts

A deploy or a publish has nothing to write, yet must not repeat while what it ships is unchanged. Give it the dependencies whose content it ships and `cacheable: true`, as in `deps: { build }, cacheable: true`. Its entry in the CAS then holds no outputs and serves as a receipt: proof that this command succeeded with this content. The next run with an unchanged `build` finds the receipt and does nothing. A changed `build` deploys again. A failure leaves no receipt, so the next run tries again.

A failed attempt's effect is not undone, so a retry can do it twice. Make the effect idempotent, or guard it: `npm view <pkg>@<version> version || npm publish …` never publishes a version twice. A receipt also lasts only as long as the CAS. On GitHub, that means [keeping the CAS between runs](github.md#keep-the-cas-between-runs).

## Post steps

A task that starts something gives its release as `post`, as a GitHub action's `post:` undoes its `main:`. Here `up:db` stands in for a database by writing an id, and creating `fail-down` or `fail-test` makes a step fail:

```ts
import { defineWorkflow } from "@mrmeku/dagworkflows";

export default defineWorkflow({
  implementation: (workflow) => {
    const db = workflow.task({
      name: "up:db",
      shell: 'echo "db-$$" > "$ID"; echo started db',
      env: ({ out }) => ({ ID: out.id }),
      outputs: { id: "id" },
      post: {
        name: "down:db",
        shell: 'if [ -n "${ID:-}" ]; then echo "stopping $(cat "$ID")"; fi; [ ! -e fail-down ]',
        env: ({ main }) => ({ ID: main.id }),
      },
    });
    workflow.task({ name: "test", shell: "[ ! -e fail-test ]", deps: { db } });
  },
});
```

`down:db` is owed the moment `up:db` starts, whatever `up:db` then does, and stays owed until it succeeds. It runs after everything downstream of its task, here after `test` whether `test` passed or not. After a cancel, dag still runs the owed post steps before it exits. `--only test` runs `up:db`, `test` and `down:db`, because `--only` brings along the post steps of the tasks it runs.

A failed post step is retried. If every try fails, the run goes red. The next run of the same file pays the debt before any task, or `npx --no dag post ci.ts` pays it: see [A post step failed, or an earlier run owes one](runs.md#a-post-step-failed-or-an-earlier-run-owes-one).

The post step reads its task's outputs under the role `main`. A task that failed or was stopped passes none, so `ID` is unset and the script tests `${ID:-}`. Write the release so it is safe to run twice and safe when nothing was set up. A post step takes no dependencies. Its task takes no `inputs` or `cacheable` and is never cached, because a cache hit starts nothing, so there would be nothing to release.

## Limits and the required check

In the first workflow, `schedulerOptions` lets at most two nodes be processed at once (`maxParallelism`). It also lets at most one task of the `test` group run at a time (`concurrencyLimits`). A task joins a group with `concurrencyGroup: "test"`. Without `schedulerOptions`, every ready node starts at once.

`workflow.requireAll({ deps: { count, flaky } })` adds one node, `require-all`. It waits for each dependency however it ends, and fails naming those that did not succeed, as in `failed: flaky`. Point branch protection at this one check instead of at each task.

## Compose workflows

`workflow.compose(other)` adds another workflow's nodes to this graph and resolves to what its implementation returns. Say `checks.ts` exports `const checks = defineWorkflow({ … })`, whose implementation adds `lint` and `test` and returns `{ lint, test }`. A workflow file then imports it with `import { checks } from "./checks.ts"` and builds on its tasks with `const { lint, test } = await workflow.compose(checks)`. Node names share one namespace, so a name both use fails the graph build. Rename one of them.

## Test a workflow

A test runs a workflow against in-memory ports. `createTestPorts` builds them around an `exec` you script, whose `run` gets each command's argv. `runWorkflow` resolves to the results and the exit code. Here `npm test` fails, and the test checks that the database was still stopped:

```ts
import assert from "node:assert/strict";
import { createTestPorts, defineWorkflow, runWorkflow } from "@mrmeku/dagworkflows";

const ci = defineWorkflow({
  implementation: (workflow) => {
    const db = workflow.task({
      name: "up:db",
      cmd: ["docker", "compose", "up", "-d"],
      post: { name: "down:db", cmd: ["docker", "compose", "down"] },
    });
    const test = workflow.task({ name: "test", cmd: ["npm", "test"], deps: { db } });
    workflow.requireAll({ deps: { test } });
  },
});

const calls: string[] = [];
const { ports } = createTestPorts({
  exec: {
    run: async (argv) => {
      calls.push(argv.join(" "));
      const ok = argv[1] !== "test";
      return { code: ok ? 0 : 1, stdout: "", stderr: "", output: "", ok };
    },
  },
});
const outcome = await runWorkflow({ ...ci, ports, casBaseDir: "/cas", historyDir: "/history" });
assert.deepEqual(calls, ["docker compose up -d", "npm test", "docker compose down"]);
assert.equal(outcome.exitCode, 1);
```

Save it as `ci.test.ts` and run `node --test ci.test.ts`. `workflow.glob` still reads the real disk. So a workflow that globs needs the in-memory file system to hold the same paths, as a map from path to text: `createTestPorts({ files: { "src/a.ts": "…" } })`. The other doubles, and every export, are in the [API reference](api/index/README.md).
