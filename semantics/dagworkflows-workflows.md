# dagworkflows: writing a workflow

## The problem

A CI job is usually a YAML list of steps that runs top to bottom, every time. Two things hurt: steps that could run side by side wait for each other, and steps whose inputs did not change run again anyway. `@mrmeku/dagworkflows` lets you write the job as a TypeScript file that builds a graph of tasks instead. Each task names what it depends on and what decides its result. The runner (the `dag` CLI locally, or the GitHub action in CI) runs independent tasks in parallel, skips a task whose result is already in a local content-addressed cache (the CAS), and runs the same file the same way on a laptop and on GitHub.

The core idea in two sentences: a workflow file default-exports `defineWorkflow({ implementation })`, and the implementation receives a `workflow` object whose methods (`task`, `cache`, `uploadArtifact`, `requireAll`, `compose`, …) add nodes to a graph. Every node is cached on a key made from what it declares (its kind, its inputs, and the content of what its deps produced), never from its code, so what a task reads must be declared.

Terms used throughout:

- **Node**: one vertex of the graph. Every method that adds work adds one or more nodes.
- **Task**: a node added with `workflow.task`. Its work is exactly one of `action` (a TypeScript function), `cmd` (a program and its arguments, run with no shell) or `shell` (a string run under bash). A task whose work is `cmd` or `shell` is called a **command**.
- **Dep**: a node this node depends on, given by a **role**, the key under which it appears in `deps`: in `deps: { pack }`, the role is `pack`.
- **Ref**: what `workflow.task` returns, a handle to the node (`NodeRef`). It has a `name` and is never part of a string.
- **Output**: a file a task writes, declared by role in `outputs`. Its path exists only once the task has run.
- **Action key**: the cache key of a node (see "The cache key of a task").
- **CAS**: the directory where outputs live, keyed by action key; `.dag/cas` by default. The [dagraph-caching](dagraph-caching.md) domain owns how it stores and verifies entries.

The engine underneath is `@mrmeku/dagraph` (domains [dagraph-graphs](dagraph-graphs.md), [dagraph-execution](dagraph-execution.md), [dagraph-caching](dagraph-caching.md)). This domain is the facade a workflow author touches. How a run is driven, cancelled and how post steps are paid is [dagworkflows-lifecycle](dagworkflows-lifecycle.md); the cache and artifact tasks in depth are [dagworkflows-cache-artifacts](dagworkflows-cache-artifacts.md); logs, terminal and summary are [dagworkflows-output](dagworkflows-output.md); the CLI flags, the GitHub action and releases are [dagworkflows-cli-action-release](dagworkflows-cli-action-release.md).

Where it lives: `packages/dagworkflows/src/workflow.ts`, `index.ts`.

## A first workflow, walked through

This file was run as written (in a scratch git repository holding `src/a.ts` and `src/b.txt`, importing the package by path) with `node …/cli.ts run ci.ts`; the output quoted below is what it printed.

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

What happens:

1. The CLI imports the file and calls the implementation once. `workflow.glob("src/**")` lists the files now, `{ "src/a.ts": file("src/a.ts"), "src/b.txt": file("src/b.txt") }`, and spreads them into `pack`'s inputs. Six nodes are added; nothing runs yet.
2. `pack` and `flaky` have no deps, so they start together (at most 2 at once, from `maxParallelism`). `flaky` exits 3 and fails with `its shell command exited 3`.
3. `report` depends on `flaky` through `settled`, so it runs anyway; `REPORT` is unset because `flaky` produced nothing, and it prints `none`.
4. `list` runs once `pack` succeeds. It gets the tarball's absolute path in `$TARBALL` and writes its own output at `$OUT`.
5. `count` runs after `list`, under the `test` group's limit of 1. Its log shows `3 entries`.
6. `require-all` waits, settled, for `count` and `flaky`, and fails with `failed: flaky`. The run exits 1.

Each node's log is also in `.dag/logs/<node>.log` ([dagworkflows-output](dagworkflows-output.md)). After this run (verified against the packed packages, in the `grouped` style), `count.log` holds `3 entries` and `report.log` holds `none`, while `pack.log`, `list.log`, `flaky.log` and `require-all.log` are empty files. A node's error is not part of its log: `require-all` prints nothing, so its log is empty although it failed with `failed: flaky`.

Run it again with nothing changed: `pack`, `list` and `count` are `cached` (they declared inputs), while `flaky` and `report` run again (they declared none), and so does `require-all`, whose failure was not cached. The recap reads `built 1 · cached 3 · failed 2 · skipped 0`. (The local recap is always `built N · cached N · failed N · skipped N`, followed by ` · cancelled N` only when a node was cancelled.) Then append a line to `src/b.txt` and run `--only count`: `pack` rebuilds (its file input changed), `list` rebuilds (its dep's content changed), but `list` writes the same listing, so `count` is `cached`. That last step is early cutoff: a dependent keys on what its dep produced, not on whether the dep ran.

## The workflow file and `defineWorkflow`

A **workflow file** is a TypeScript module whose default export is the value `defineWorkflow` returns. The CLI (`dag run <file>`, `dag post <file>`) and the GitHub action load it by path. A module whose default export is anything else is refused with:

```
<file> default-exports no workflow: export default defineWorkflow({ ... })
```

The check is on a brand `defineWorkflow` stamps on its result, the key `Symbol.for("@mrmeku/dagworkflows/WorkflowDef")`, so a hand-built object of the same shape is refused. Only the key's presence is tested, and the symbol comes from the global registry, so the value of `defineWorkflow` from another copy of the package passes, as does any object carrying that key.

`defineWorkflow(def)` takes:

- `implementation(workflow)`: required. Builds the graph through the `workflow` object. May be `async` (it is awaited), and may return a value, which `workflow.compose` hands back to a workflow that composes this one. The runner ignores what it returns.
- `summary`: optional, a list of `SummaryRenderer`s; defaults to `DEFAULT_SUMMARY_RENDERERS`. A custom list is built from the exported `renderStatus`, `renderTimeline`, `renderCriticalPath`, `renderDag`, `renderFailures` and `renderTable`, or functions of your own over a `RunReport` ([dagworkflows-output](dagworkflows-output.md) owns them).
- `schedulerOptions`: optional, `{ maxParallelism?, concurrencyLimits? }` (see "Scheduler options and concurrency groups"). Its `concurrencyLimits` keys become the only concurrency group names that compile in this workflow.

It returns a `WorkflowDef<R, G>`: `implementation` (rewrapped to take a graph, ports and context, as the runner calls it; its type is the exported `Implementation<R>`), `schedulerOptions` and `summary` when given. `R` is what the implementation returns; `G` the declared groups.

When the implementation runs: once per invocation (`dag run`, `dag post`, the action's main and post entries), before any node starts. A `dag run` builds the graph once, pays from that same graph any post steps earlier runs owe, then runs the selection; it does not build again per pass. A `dag post` builds it again to find the post steps, and so does the post pass `runJob` starts after a cancel. So the implementation must be a pure description: no side effects, no commands. The types enforce the last part: `workflow.ports` has no `exec`.

Conditional work is ordinary code at build time, reading `workflow.ctx` or `workflow.ports.env`: `if (workflow.ctx.ref === "refs/heads/main") cas.save()`. There is no `if:` field on a task.

### Type-checking a workflow file

Node strips a workflow file's types without checking them, so what this page says "does not compile" shows only in an editor or under `tsc --noEmit`. This `tsconfig.json`, with `typescript` and `@types/node` installed beside the package, type-checks the first example, a receipt task as below, the compose example below (its `checks` in a file of its own, `checks.ts`) and the test example below. Verified with TypeScript 6.0.3 and 5.9.3, against the packages as `scripts/pack.ts` packs them:

```json
{
  "compilerOptions": {
    "noEmit": true,
    "target": "esnext",
    "module": "nodenext",
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "types": ["node"]
  }
}
```

What each setting is for:

- `module: "nodenext"` resolves imports as Node does: through `exports`, and with relative imports carrying their extension. With no `module` setting, TypeScript 5.9 resolves as `node10` and finds no declarations for `@mrmeku/dagraph`, whose `package.json` has only `exports`. It then reports the tasks themselves as wrong (`… is missing the following properties from type 'CommandFields<…>': cacheable, timeoutMs`). `moduleResolution: "bundler"` resolves the packages, but it accepts `import { checks } from "./checks"`, which Node refuses at run time with `ERR_MODULE_NOT_FOUND`.
- `allowImportingTsExtensions` accepts `import { checks } from "./checks.ts"`, the form Node needs. Without it, that import is `TS5097`. It is allowed only beside `noEmit` (else `TS5096`). `rewriteRelativeImportExtensions: true`, which Node's TypeScript documentation (`https://nodejs.org/api/typescript.html`) recommends, accepts it as well (verified in its place). Under `nodenext` an extensionless import is `TS2835`, whose suggestion `./checks.js` type-checks but fails under Node: write `.ts`.
- `erasableSyntaxOnly` refuses what Node cannot strip, with `TS1294`. Without it an `enum` type-checks, then fails under `dag run` with `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode`.
- `verbatimModuleSyntax` requires `type` on a type-only import, with `TS1484`. Without it, `import { defineWorkflow, Workflow } from "@mrmeku/dagworkflows"` type-checks, then fails under `dag run` with `SyntaxError: The requested module '@mrmeku/dagworkflows' does not provide an export named 'Workflow'`. Write `type Workflow`.
- `types: ["node"]`: the package's declarations name the `NodeJS` namespace (`NodeJS.ProcessEnv` for `ports.env`), and TypeScript 6.0 loads no `@types` package unless it is listed. Without it they fail with `Cannot find namespace 'NodeJS'` (`skipLibCheck` hides that), and a test's `import assert from "node:assert/strict"` with `TS2591`.
- `strict` is TypeScript 6.0's default, not 5.9's. The first, compose and test examples also type-check with `exactOptionalPropertyTypes` added.

Where it lives: `workflow.ts`, `runner.ts` (when it is called); the dag repository's `scripts/pack.ts` (the packed `exports` and `types`).

## The `workflow` object

The implementation receives a `Workflow<G>`, where `G` is the union of the declared concurrency group names (`never` when none are declared). Its members:

| Member                                      | What it is                                                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task(spec)`                                | Adds a task, and its post step when `spec.post` is given. Returns a `NodeRef` whose output roles are the keys of `spec.outputs`.                      |
| `requireAll({ name?, deps })`               | Adds a required-check node that fails if any of `deps` did not succeed. Returns a ref with output `outcome`.                                          |
| `cache({ name?, path, key, restoreKeys? })` | Adds `restore:<name>` (name defaults to `cache`) and returns `{ restore, save }`; `save(saveSpec?)` adds `save:<name>`. `actions/cache` as two tasks. |
| `uploadArtifact(spec)`                      | Adds a node that uploads files as one artifact of the run. Returns a ref with output `response`. `actions/upload-artifact` as a task.                 |
| `compose(other)`                            | Adds another workflow's nodes to this graph and resolves to what its implementation returns.                                                          |
| `glob(...patterns)`                         | Resolves to a record of matched file paths, each as `file(path)`, ready to spread into `inputs`.                                                      |
| `hash(...patterns)`                         | Resolves to GitHub's `hashFiles()` of the patterns: one hex string, or `""` when nothing matches.                                                     |
| `ctx`                                       | The CI context, a `CiContext` (below).                                                                                                                |
| `ports`                                     | The run's ports minus `exec`, a `WorkflowPorts` (below).                                                                                              |
| `graph`                                     | The underlying dagraph `Graph<Ports>`, for adding nodes of your own dagraph actions.                                                                  |

### `workflow.ctx`

A `CiContext`: the fields of `@actions/github`'s `context` a workflow reads, `ref`, `sha`, `eventName`, `actor`, `runId`, `repo` (`{ owner, repo }`) and `serverUrl`, plus `isCi` and `provider`.

- On GitHub: the toolkit's own values, `isCi: true`, `provider: "github"`. `ref` is e.g. `refs/heads/main` or `refs/pull/12/merge`.
- Locally: from git. `ref` is `refs/heads/<branch>` (the output of `git symbolic-ref HEAD`), `""` on a detached HEAD; `sha` is `git rev-parse HEAD`; `actor` is `git config user.name`, else `$USER`, else `""`; `eventName` is `"local"`; `runId` is `0`; `repo` is `{ owner: "", repo: "" }`; `serverUrl` is `""`; `isCi: false`, `provider: "local"`. Outside a git repository (or without git) `ref` and `sha` are `""`.
- `provider` is typed `string`. Besides `"github"` and `"local"`, `nullHost` gives `"none"` and the test ports' recording host `"recording"`, each with empty strings, `runId` 0 and `isCi: false`.

So `workflow.ctx.ref === "refs/heads/main"` is true both on a push to main and on a laptop checked out on main.

### `workflow.ports`

A `WorkflowPorts`: every port of the run but `exec`. A workflow and an action read:

- `fs`: dagraph's file system port (`exists`, `readText`, `writeText`, which makes parent directories, `hashFile`, `ensureDir`, `rename`, `remove`, `readdir`, `resolve`).
- `env`: the process environment (`process.env` in the CLI and the action). Read it at build time and put what matters in `inputs`: `inputs: { mixEnv: workflow.ports.env.MIX_ENV ?? null }`. Nothing reads it for you; a command inherits the real process environment regardless.
- `clock`, `host`, `cacheStore`, `artifactStore`, `lockfile`: the run's other ports. A workflow rarely touches them; the built-in tasks use them.

`exec` is left out of the type on purpose: a command must run inside a node (as a `cmd`/`shell` task, or through `run`/`runShell` in an action) where it is logged, timed out and cancelled.

### `workflow.glob(...patterns)` and `workflow.hash(...patterns)`

`glob` matches files by `@actions/glob`'s rules, the same ones `actions/cache`, `actions/upload-artifact` and `hashFiles()` use: one pattern per argument, `!` negates, `**` crosses directories, a directory pattern (`src`) matches every file under it, a line starting with `#` is a comment (the patterns are joined with newlines). It never returns directories. Symbolic links are followed and broken ones left out, as `@actions/glob`'s defaults do. It always appends negations for `DEFAULT_EXCLUDES`, which is `[".git", "node_modules", ".dag"]` (as `!**/<dir>/**`). Paths are relative to the process's working directory (the repository root when run there), so a match outside it comes back as a `../` path; they are sorted and deduplicated. The result is `{ [path]: file(path) }`, `{}` when nothing matches or when no pattern is given.

Examples (verified):

- `glob("src/**")` → `src/a.ts`, `src/b.txt`, `src/dist/out.js`
- `glob("src/**", "!src/dist/**")` → `src/a.ts`, `src/b.txt`
- `glob("**/*.js")` with a `node_modules/x/i.js` present → only `src/dist/out.js`
- `glob("nope/**")` → `{}`

Start each pattern at the directory it needs (`src/**`, not `**/*.ts`): a negation filters results but does not stop the walk, so `**` still walks `node_modules`.

`hash` passes its patterns, joined with newlines, to `@actions/glob`'s `hashFiles` unchanged, without the default excludes (so `hash("node_modules/**")` is not empty). The result is the SHA-256 over each matched file's SHA-256, or `""` when nothing matches. As GitHub's `hashFiles()` does, it hashes only files under `$GITHUB_WORKSPACE`, or under the working directory when that is unset: a pattern that reaches outside (`../x/**`, an absolute path elsewhere) adds nothing, and gives `""` if nothing else matches. Use it for a cache key: `key: \`deps-${await workflow.hash("bun.lock")}\``.

Both run at build time and load `@actions/glob` on first use; an `uploadArtifact` whose `path` holds a glob loads it at run time. Off GitHub (when `GITHUB_ACTIONS` is unset at that moment), loading it patches `process.stdout.write` for the rest of the process so that any string chunk starting with `::debug::` is dropped: the lines the globber prints for every file it visits, and anyone else's too.

Both read the real disk under the real working directory, never `ports.fs`. The file list is fixed when the graph is built; each file's content is hashed later, when its node is about to run.

Where it lives: `workflow.ts`, `ports/glob.ts`, `config.ts` (`DEFAULT_EXCLUDES`), `ports/local.ts` and `ports/github.ts` (context).

## Tasks

`workflow.task(spec)` takes a `TaskSpec`: one of `ActionTaskSpec`, `CmdTaskSpec` or `ShellTaskSpec`, plus an optional `post`. Giving two of `action`, `cmd` and `shell`, or none, does not compile. Past the types (plain JavaScript, a cast), `action` silently wins over `cmd` and `shell`, and `shell` over `cmd`; with none, the add fails with a `TypeError` from reading `cmd` (under Node, `node "<name>": Cannot read properties of undefined (reading 'map')`).

Fields every task takes:

| Field              | Meaning                                                                                       | Default                                        |
| ------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `name`             | The node's address in logs, check runs, the summary and `--only`. Unique in the graph.        | required                                       |
| `deps`             | The nodes it depends on, by role: `{ pack }`, or `{ tests: settled(tests) }`.                 | none                                           |
| `inputs`           | What else decides its result, by name: `file(path)` or JSON values.                           | none                                           |
| `outputs`          | The files it writes, by role, as file names in its output directory: `{ notes: "notes.md" }`. | none                                           |
| `cacheable`        | Force caching on or off.                                                                      | on exactly when `inputs` holds a defined value |
| `timeoutMs`        | How long its work may run, from its start, in ms. Whole number from 1 to 2147483647.          | no limit                                       |
| `concurrencyGroup` | A group declared in `schedulerOptions.concurrencyLimits`.                                     | none                                           |
| `post`             | Its release step (see "Post steps"). Excludes `inputs` and `cacheable`.                       | none                                           |

### Action tasks (`action`)

The work is a function, `action(context)`, returning nothing (or a promise of nothing). The context holds:

- `inputs`: its `inputs`, a `file()` as a `FileHandle` and a value as written.
- `depOutputs`: each dep's outputs by role, each output a `FileHandle` (or a list of handles). A `settled` dep that did not succeed is `undefined`, as is a role given `undefined`.
- `out`: each declared output by role, as an absolute path in the output directory. Write each before returning.
- `outputDir`: the absolute path of a fresh, empty directory only this attempt writes.
- `signal`: an `AbortSignal` that fires on the task's timeout or the run's cancel.
- `ports`: `WorkflowPorts`, as `workflow.ports`.
- `run(argv, options?)`: runs a program with no shell. `options` is `{ cwd?, env? }`: `cwd` is relative to the process's working directory, and `env` is set over the real process environment (`process.env`, not `ports.env`), where a value of `undefined` unsets that variable. A `PATH` in `env` changes where the program (or `bash`) is looked up, so `env: { PATH: "/nonexistent" }` fails with `could not start …`. Resolves with its stdout; throws on a nonzero exit. Its output is streamed into the task's log.
- `runShell(command, options?)`: runs a string under `bash --noprofile --norc -eo pipefail -c`, otherwise as `run`. Pass a path through `env` and quote it: `runShell('tar -tzf "$TARBALL"', { env: { TARBALL } })`.
- `log(line)`: appends a line to the task's log.
- `warn(message)`: appends a GitHub warning to the log, `::warning title=<task name>::<message>`, with `%`, CR, LF (and in the title `:` and `,`) escaped as the toolkit escapes them. On GitHub it becomes an annotation; locally the terminal shows it apart.

A `FileHandle` (from dagraph) has `path` (absolute, for a tool that takes a path), `text()`, `json(isT)` (checked by a type guard), and `hash()`. It cannot be put in a string; use `.path`. The guard is required: `json()` with none does not compile, and forced through, it fails the task under Node with the `TypeError` `is is not a function` (`is` is the guard's parameter), once the file has parsed (verified).

What the action throws reaches the result with its `name` and `message`, and its `cause` only as a JSON copy: an `Error` cause becomes `{ name, message, cause }` (converted the same way), and a cause that is not JSON (holding a `Date`, a class instance) is left out. After the action returns, every declared output must exist, else the task fails with:

```
output "report" (report.xml) was not written. Write it at out.report before the action returns.
```

An action task's kind, which joins its cache key, is its `name`: renaming it runs it again. Its code is not in the key, so a change to what the action does needs a change in its inputs. The convention is a version input you bump: `inputs: { version: "manifest-v1", os }`, read back as `inputs.os`.

`inputs` is a record for an action task (no function form).

### Command tasks (`cmd` and `shell`)

A command takes, besides the common fields:

- `cmd`: an argv, `["bun", "run", "lint"]`, or a function of the command's refs that returns one. Run with no shell.
- `shell`: a string, run under `bash --noprofile --norc -eo pipefail -c` (GitHub's `shell: bash`), so a failing command or any failing stage of a pipe fails the task.
- `cwd`: where it runs, relative to the repository root (the process's working directory). Default: that directory.
- `env`: variables set over the environment it inherits (the real `process.env`, as for `run`): a record of strings, or a function of its refs that returns one.

The function forms (`cmd: (refs) => …`, `env: (refs) => …`) receive one argument holding:

- each dep by its role, whose properties are refs to that dep's outputs: `({ pack }) => [..., pack.tarball]`;
- `out`, refs to its own declared outputs: `out.tarball`;
- `outputDir`, a ref to its own output directory.

So `deps` may not use the roles `out` or `outputDir` (does not compile).

The functions run once, when the node is added, not when it runs. A ref is a placeholder that becomes an absolute path only when the command starts. Rules that follow:

- **A ref is a whole argument or a whole env value**, never part of a string. `cmd: ({ pack }) => ["npm", "publish", pack.tarball]` works; ``[`--file=${pack.tarball}`]`` or `"--file=" + pack.tarball` does not compile, and if forced through it is refused when the node is added:
  - a dep's ref: `node "a": pack.tarball can't be part of a string: its path exists only once "pack" has run. Make it its own array item or property: [..., pack.tarball] or { tarball: pack.tarball }.`
  - its own `out` in `cmd`: `node "x": out.id can't be part of a string. Make it its own argument: cmd: ({ out }) => [..., out.id].`
  - its own `out` in a `cmd` task's `env`: `node "z": out.id can't be part of a string. Make it its own env value: env: ({ out }) => ({ OUT: out.id }).`
  - its own `outputDir` in a `shell` task's `env`: `node "y": outputDir can't be part of a string. Make it its own env value, read quoted: env: ({ outputDir }) => ({ OUT: outputDir }), then "$OUT".`
  - a ref (the node itself) in a string: `node "pack" can't be part of a string. Put it in deps: deps: { pack }.`
- **For `--file=<path>`, use `shell`**: `env: ({ pack }) => ({ FILE: pack.tarball }), shell: 'tool --file="$FILE"'`.
- **A `shell` string never holds a ref**; every ref, `outputDir` too, reaches it through `env`, read quoted.
- **A ref goes only in what the call that received it returns.** A ref kept in a variable and used by another task does not compile.
- **The refs of a dep cannot be listed**: `Object.values(pack)` or a spread throws `the refs of pack cannot be listed: name each output, as pack.<output>`.
- **A plain (non-function) `cmd` cannot hold a ref**; refs come only from the function's argument.
- **A `settled` dep's outputs may only go in `env`**, never as an argument (does not compile). If that dep did not succeed, the variable is unset, even if the inherited environment has it. Test it: `if [ -n "$REPORT" ]; then …; fi`. Forced through the types into an argv (Node strips them unchecked), the ref works while the dep succeeds: the argument is its absolute path and the command runs. When the dep did not succeed, the task fails before its command starts, with the `TypeError` `Cannot read properties of undefined (reading 'path')` and no `CommandCause`. That failure is named like any other: the `reproduce:` line and the failures report name it beside the dep.
- **A dep given as `undefined`** has no refs: check before use, `...(pack ? [pack.tarball] : [])`.
- **A dep output holding a list of paths** reaches the command as those absolute paths joined with `:`.
- **Static `env` values** are plain strings.

At start, each ref is filled with an absolute path, so a command with its own `cwd` still finds them even when the CAS directory is relative.

Failures a command meets, as the task's error message:

- nonzero exit of `cmd`: `<argv joined by spaces> exited <code>`, e.g. `bad --flag exited 1`;
- nonzero exit of `shell`: `its shell command exited <code>`;
- a program that cannot start: `could not start <program>. Check that it is on the command's PATH and that its cwd exists.` (also `bash` for a `shell` task on a machine without bash);
- a cancel: the task ends `cancelled`, whatever the command's exit status;
- a timeout: the engine fails it as a `TimeoutError` with the message `timed out after <n> ms`, whatever the exit status (a command that traps the stop signal and exits 0 still fails); the reporter shows `The action '<name>' has timed out after <d>.`, where `<d>` is e.g. `300ms`, `1.5s` or `2 minutes`;
- a declared output not written: the message above.

Every failure the task wrapper raises (a nonzero exit, a program that could not start, a declared output not written) carries a `cause` of type `CommandCause`: `{ argv, cwd, ended, code }`, the last command the task ran (`cwd` is `"."` when none was given; `ended` is `exited`, `signalled` or `not-started`, as its `ExecResult` says). For a shell command `argv` is the whole bash invocation ending in the string; a program that could not start has `ended: "not-started"` and `code: -1`; an output not written after a successful command has `code: 0`, and no cause if no command ran. So a cause does not by itself mean a command failed. The same holds for `run`/`runShell` in an action task, while an error the action throws itself keeps its own cause. A timeout keeps the cause of what was thrown as it stopped.

A command makes only the output directory; for a nested output (`outputs: { report: "reports/junit.xml" }`) the command must create `reports/` itself, as with `mkdir -p "$(dirname "$OUT")"`. A command that writes into the missing directory fails with the ordinary nonzero-exit error (`touch <path> exited 1` for a `cmd`, `its shell command exited 1` for a `shell`), and its log holds the tool's own message, which ends in the system's `No such file or directory`. Verified on macOS, where `<dir>` is the attempt's staging directory `<cas>/<action key>/tmp-<uuid>`: `cmd: ({ out }) => ["touch", out.report]` logs `touch: <dir>/reports/junit.xml: No such file or directory`, and `shell: 'echo "<testsuites/>" > "$OUT"'` logs `bash: line 1: <dir>/reports/junit.xml: No such file or directory`. An action writing with `ports.fs.writeText` gets parent directories made for it.

Commands inherit the whole process environment, secrets included; what they print goes to their log beside the CAS, never into it.

A command never talks to a terminal. Its stdin is the null device (`/dev/null`, not a closed descriptor), so a `read` gets end of file at once, its stdout and stderr are pipes the task reads (so `[ -t 1 ]` is false, and a tool that colours only on a terminal does not), and it runs in a session of its own with no controlling terminal (opening `/dev/tty` fails). So a command that asks a question cannot be answered: give it its non-interactive flag (`--yes`, `CI=true`, …). Verified in a scratch repository: a `shell` task testing each prints `in-notty`, `out-notty`, `read-eof` and `devtty-no`. The same holds for `run`/`runShell` in an action, locally and on GitHub.

A command's kind is `run` for `cmd` and `run-shell` for `shell`. Its name is not in its key, but its line, `cwd` and `env` are (see below), so two identical cached commands share one cache entry, and renaming one still hits.

`inputs` for a command is a record. The names `declaredOutputs` and `command` are reserved and do not compile. Past the types, `declaredOutputs` is refused when the node is added, for any task: `node "<name>": inputs.declaredOutputs is declared by its action "<kind>". Give the node's input another name.` (the kind is `run`, `run-shell`, or an action task's name). For `command` the types are the only guard; at runtime the author's value is silently replaced.

### Choosing between an action and a command

The choice follows from what keys each kind and what each receives.

- **Run a program as a command.** Its line, `cwd` and static `env` join its key, so editing the command reruns it without a version bump, and renaming it still hits. Use `cmd` for one program and its arguments, and `shell` when the line needs bash: a pipe, `&&`, a redirect, or a ref inside an argument such as `--file="$FILE"`.
- **Write an action when the work is TypeScript logic.** Only an action receives its deps' outputs as `FileHandle`s to read (`text()`, `json(isT)`, `hash()`) and reaches the ports: `ports.fs` (whose `writeText` makes parent directories), `ports.env`, and the cache and artifact stores. The built-in `require-all`, `restore:<name>`, `save:<name>` and `uploadArtifact` nodes are action tasks: each reads its deps' outputs or a store. An action can also run several programs with logic between them through `run` and `runShell`, and build an argument from a path, since a handle's `path` is a plain string at run time: ``run(["tool", `--file=${depOutputs.pack.tarball.path}`])`` works with no shell.
- **What an action costs.** Neither its code nor the argv of a `run`/`runShell` inside it is in its key: verified, an action running `run(["echo", WORD])` stayed `cached` when `WORD` changed, while a `cmd: ["echo", WORD]` task beside it reran. So a change to what an action does, the commands it runs included, needs a bump of its version input, and renaming it reruns it. Wrapping a single program in an action therefore gives up the automatic keying a command has.

Where it lives: `task.ts`, `commands.ts`, `ports/real.ts`, `step-records.ts`.

## Dependencies

`deps` is a record from role to ref. A role names the dep for the task: the function argument of a command and `depOutputs` of an action read it by role. The key reads it by role too, and by the dep's content hash, never by the dep's name: renaming a dep changes no dependent's key as long as the dep writes the same content, but giving a dep another role does. The renamed dep's own key is another matter: a command's stays the same, while an action task's (including `requireAll`, `uploadArtifact`, `restore` and `save`) changes, because its kind is its name, so it runs again.

Three kinds of entry:

- **Required** (`{ pack }`): the task runs only once `pack` succeeded (ran or was cached). If `pack` failed or was itself skipped, the task is skipped as `dep-failed`. (After a cancel, nodes not yet started end `cancelled`; [dagworkflows-lifecycle](dagworkflows-lifecycle.md).)
- **Settled** (`{ tests: settled(tests) }`): the task waits for `tests` to settle, whatever came of it, like GitHub's `if: always()`. Its outputs are `undefined` in `depOutputs`, and unset in `env`, when it did not succeed. In the key such a dep counts as "missing".
- **`undefined`** (`{ pack: maybePack }` where `maybePack` is `undefined`): the role is left out, so a builder can make a dep optional. For a command its refs are `undefined`.

A dep is resolved by its node's name. A ref whose name this graph does not hold is refused: `node "f": deps.x is "x", which this graph does not hold. Add that node first.` A ref from another graph whose name this graph also holds is accepted silently and points at this graph's node. Nodes must be added in dependency order, which code order gives naturally. A duplicate name fails with `Duplicate node name "pack". Names are unique in a graph: give the node a name of its own, or add it through graph.subgraph(prefix, meta).`

A failed node's outputs reach no one: its directory is dropped. A report wanted after a failure (test results) should be written into the working tree and uploaded by glob: `uploadArtifact({ …, path: ["reports/**"] })`.

## Inputs

`inputs` names what, besides its deps, decides a task's result. Each entry is:

- a **file**: `file(path)`. Its path as written and its content's SHA-256 join the key. The action reads it as a `FileHandle`. Usually spread from `workflow.glob`. The file is hashed when the node is about to run; a missing one fails the node before it starts, with the file system's error (e.g. `ENOENT: no such file or directory, open 'no-such.json'`).
- a **value**: a string, a finite number, a boolean, `null`, or an array or plain object of these. It joins the key as JSON with sorted keys. A property that is `undefined` is dropped. Values are copied when the node is added, so changing the object afterwards changes nothing.

A `file()` put into a string is refused: `file("<path>") can't be part of a string. Make it its own input: inputs: { "<path>": file("<path>") }.`

Values that are refused when the node is added, each with its path in the message:

- `NaN`/`Infinity`: `node "d": inputs.ratio is NaN, which is not JSON. Give a finite number, or null.`
- a class instance (e.g. a `Date`): `node "e": inputs.at is a Date, which is not JSON. Give a plain object of its fields: { ...at }.`
- a function, a symbol, a bigint, `undefined` inside a list: each refused with a fix.

Variables (environment, branch) are values read at build time: `inputs: { mixEnv: workflow.ports.env.MIX_ENV ?? null }`. Use `?? null` rather than leaving `undefined`, which is dropped (and would not make the task cacheable).

Whether a task is cached follows from its inputs: a task (action or command) is cached exactly when its `inputs` hold at least one value that is not `undefined`. `inputs: {}` (a glob that matched nothing) leaves it uncached. A command's own line does not count. `cacheable: true` caches a task with no inputs (its key is then its kind, line and deps); `cacheable: false` runs a task with inputs every time. A command that writes the working tree for others, like `bun install`, must run every time: give it no inputs, or `cacheable: false`.

Where it lives: `task.ts`, `commands.ts`, dagraph `graph/inputs.ts`.

## When a task runs

A node ends in one of these states: `done` (ran and succeeded), `cached` (its entry was found and verified; it did not run), `failed`, `dep-failed` (skipped because a required dep did not succeed) and `cancelled` (stopped by a cancel, or never started because of one). [dagraph-execution](dagraph-execution.md) owns the details.

For each node, in the order its deps settle, once it has taken a place in `maxParallelism`:

1. If a required dep did not succeed, it is `dep-failed`. Its action never runs.
2. Its action key is computed (file inputs hashed). A failure here (a missing input file) fails it.
3. If it is cacheable and the run is not forced (`--force`), and the CAS holds a verified entry for the key, it is `cached`.
4. Otherwise, without a concurrency group, it runs at once. With one, it gives its place back while it waits for its group's slot, then takes both and runs.

On success its outputs are published in the CAS directory under its key either way; the cache entry that lets a later run hit is written only when it is cacheable. A failure, a timeout or a cancel is never cached. `--force` skips the lookup, but a forced success still writes its entry.

Which nodes are never cached, whatever their inputs: a task with a `post`, the post step itself, `restore:<name>`, `save:<name>` and every `uploadArtifact` node. `requireAll` is cacheable (it has a version input), so a green required-check whose deps did not change is `cached`.

### Side effects: the receipt pattern

A task whose point is an effect outside the CAS (a deploy, an `npm publish`, a push) usually has nothing to write, yet must not repeat its effect when nothing it ships has changed. Make it cacheable and key it on what it ships: give it the deps whose content it sends out and `cacheable: true` (or a version input). Its cache entry, which holds no outputs, is then a **receipt**: proof that this exact effect, with this exact command and these exact dep contents, succeeded. The next run with the same deps is `cached` and does nothing; a run whose deps changed does the effect again. A failure is never cached, so a failed effect is tried again on the next run.

Verified as a whole file, `ci.ts`, in a scratch git repository holding `a.txt` (content `a`) and a `package.json` of `{ "type": "module" }`, with `@mrmeku/dagworkflows` resolved from `node_modules`. It type-checks under `strict` and `exactOptionalPropertyTypes`, and each step below ran `npx --no dag run ci.ts --output-style grouped`. `deploy` stands in for a deploy by appending to `deploys.log`, and creating `fail-deploy` makes it fail after its effect:

```ts
import { defineWorkflow } from "@mrmeku/dagworkflows";

export default defineWorkflow({
  implementation: async (workflow) => {
    const build = workflow.task({
      name: "build",
      inputs: { version: "build-v1", ...(await workflow.glob("a.txt")) },
      outputs: { site: "site.txt" },
      shell: 'cat a.txt > "$OUT"',
      env: ({ out }) => ({ OUT: out.site }),
    });
    workflow.task({
      name: "deploy",
      deps: { build },
      cacheable: true,
      shell: 'echo "deployed $(cat "$SITE")" >> deploys.log; [ ! -e fail-deploy ]',
      env: ({ build }) => ({ SITE: build.site }),
    });
  },
});
```

1. First run: `build` and `deploy` are built (`built 2 · cached 0 · failed 0 · skipped 0`), exit 0; `deploys.log` holds `deployed a`.
2. Second run, nothing changed: both `cached` (`built 0 · cached 2`); `deploys.log` unchanged.
3. Change `a.txt` to `b` and `touch fail-deploy`: `build` rebuilds, `deploy` runs, appends `deployed b`, then fails with `its shell command exited 1` (`✖︎ deploy failed`, `built 1 · cached 0 · failed 1 · skipped 0`, `reproduce: npx --no dag run ci.ts --only deploy`), exit 1.
4. `rm fail-deploy` and run: `build` is `cached`, `deploy` runs again (its failure left no receipt) and appends a second `deployed b` (`built 1 · cached 1`), exit 0.
5. Run again: both `cached`; `deploys.log` unchanged.
6. Run with `--force`: both run (`built 2 · cached 0`), and `deploy` appends a third `deployed b`.

What this shows, and the rules that follow:

- The effect of a failed attempt is not undone: step 3 wrote before it failed, so step 4 did it twice. Make the effect idempotent, or guard it: the dag repository's own publish runs `npm view @mrmeku/<pkg>@<version> version || npm publish "$TARBALL" …`, so a run without its receipt still never publishes a version twice.
- A receipt lives in the CAS, so it lasts only as long as the CAS does: on a fresh GitHub runner, only if the workflow caches the CAS ([dagworkflows-cache-artifacts](dagworkflows-cache-artifacts.md)). Without it, every run repeats the effect, which is why the guard above matters.
- The receipt's key is the kind (`run`/`run-shell`, or an action task's name), the command line, `cwd`, static `env`, and the deps' content by role. A different command, such as the same publish with `--dry-run`, is a different key, so a dry run's receipt never stands in for the real one.
- A task with a `post` cannot be cacheable (it does not compile), so an effect that needs a release cannot have a receipt.
- To repeat an effect on purpose, run with `--force`, or change its inputs.

Where it lives: `task.ts`, `commands.ts`; the dag repository's `scripts/release.ts` (`publish:*`, `release:action`).

## The cache key of a task

The action key is the SHA-256 of three things, and nothing else: the node's **kind**, its **inputs** by name, and its **deps** by role.

- **Kind**: for an action task, its `name`; for a `cmd` task `run`; for a `shell` task `run-shell`; for a post step that is a command, `post`; for a post step that is an action, its own name.
- **Inputs**: the author's `inputs` (files by path and content hash, values as canonical JSON), plus two the facade adds:
  - `declaredOutputs`: the `outputs` record, so changing an output's file name changes the key;
  - for a command, `command`: its line as written (a `shell` string, or the argv with each dep ref as the role and output name it points through, and each own ref as its file name or as "the output dir"), its `cwd` and its `env` as written, plus an internal version tag.
- **Deps** by role: each dep's content hash, which is a hash of its outputs' names, their file paths relative to its output directory and their contents; or "missing" for a settled dep that did not succeed.

Not in the key: the action's function body; a task's name, unless it is an action task; the deps' node names; `timeoutMs`; `concurrencyGroup`; `cacheable`; the CAS directory (moving it changes no key); the inherited environment; absolute paths.

Consequences an author meets:

- Two identical cached commands share one entry; renaming a cached command still hits. Renaming an action task runs it again.
- Changing a command's argv, `cwd` or static `env` reruns it. Changing a program's source does not, unless its files are in `inputs`.
- Changing what an action does needs a version bump in `inputs`.
- Early cutoff: a dep that runs again and writes byte-identical outputs does not rerun its dependents.

A task with no inputs and no `cacheable: true` has a key all the same: its log is stored under it ([dagworkflows-output](dagworkflows-output.md)).

Where it lives: `task.ts`, `commands.ts`, dagraph `content-addressing.ts` and `process-node.ts`.

## Outputs

`outputs` declares each file a task writes, by role, as a name inside its output directory: `{ tarball: "pkg.tgz" }`, or nested, `{ report: "reports/junit.xml" }`. Each is checked when the task is added. An absolute path, a `..` segment, or a name whose last segment is empty, `.` or `..` is refused:

```
task "x": outputs.report is "/tmp/report.xml", not a file in its output directory. Name a file in it, as "report.xml".
```

(`reports/` and `""` give the same message without the `, as "…"` suggestion. For a post step the prefix is `post "<name>" of task "<main>"`.)

The ref `workflow.task` returns carries the output roles only in a phantom type field, not as properties: the ref has no `tarball` property, so any property read on it besides `name` fails to compile, with no suggestion. A misspelling is caught, with `Did you mean 'tarball'?`, where the outputs are read: in a command function's argument (`({ pack }) => [..., pack.tarbal]`) or in `depOutputs.pack.tarbal`. Naming an output role in the type parameters without declaring it in `outputs` does not compile.

Inside the task, `out.<role>` (action) or the `out` ref (command) is an absolute path in a fresh staging directory. On success the directory moves to `<cas>/<actionKey>/out-<contentHash>/`, and the node's result records each output's path there, relative to the working directory when the CAS directory is relative. A dependent receives absolute paths.

A task with no outputs is fine: its result is `{}`. That is how `restore:<name>` is built.

## Scheduler options and concurrency groups

`schedulerOptions` on `defineWorkflow` takes:

- `maxParallelism`: the most nodes being processed at once, like Ninja's `-j`. A node holds its place from its key computation (file hashing included) until it settles. The one exception: a miss in a concurrency group gives its place back while it waits for its group's slot.
- `concurrencyLimits`: for each group name, the most of its nodes running at once. A cache hit takes no group slot.

Each limit must be a whole number from 1, or `Infinity`. Otherwise the run fails before any node starts with, e.g., `throttledScheduler: maxParallelism must be a whole number from 1, or Infinity, got 0`. Without `schedulerOptions` (or with neither field) every ready node starts at once.

A task joins a group with `concurrencyGroup: "test"`. Groups are checked by the types: `concurrencyGroup` accepts only the keys of this workflow's `concurrencyLimits` (type `GroupsOf<S>`), so a misspelt group does not compile. Pass the options inline (or with `as const` or `satisfies ThrottledSchedulerOptions`) so their keys are inferred. A variable holding them with no type annotation keeps the keys too, whether `const` or `let`: with `const options = { maxParallelism: 2, concurrencyLimits: { test: 1 } }` and `schedulerOptions: options`, `concurrencyGroup: "tset"` fails with `Type '"tset"' is not assignable to type '"test"'`. `ThrottledSchedulerOptions` is not exported by `@mrmeku/dagworkflows`; import it from `@mrmeku/dagraph`. Options typed as the wide `ThrottledSchedulerOptions` give `GroupsOf` `never`, because `concurrencyLimits` is optional there, so `concurrencyGroup` then accepts no group name at all: `concurrencyGroup: "test"` fails with `Type 'string' is not assignable to type 'undefined'`. Limits typed `Record<string, number>`, inline (`concurrencyLimits: limits`) or in an options variable typed `{ concurrencyLimits: Record<string, number> }`, give `GroupsOf` `string`, so any group name compiles. (All verified with `tsc`.) At runtime a group with no limit is unlimited, and nothing warns: a misspelt group forced through the types, a name a `Record<string, number>` lets through, or a composed workflow's group this workflow does not declare (see "Helpers and composing workflows").

A task's duration counts from its action's start, never from its wait for a slot.

Where it lives: `workflow.ts` (`GroupsOf`), dagraph `schedulers.ts`.

## Helpers and composing workflows

A function that adds tasks takes the `workflow` object. Its type says which groups it needs:

- `(workflow: Workflow) => …` uses no group, and accepts the object of any workflow.
- `(workflow: Workflow<"mix">) => …` sets `concurrencyGroup: "mix"`, and accepts only a workflow that declares `mix`.

`workflow.compose(other)` runs another workflow's implementation against this graph, with the same ports and context, and resolves to what it returns. The other workflow's `schedulerOptions` and `summary` do not apply, so this workflow must declare every concurrency group the other declares; composing one whose groups this one lacks does not compile (`Type '"test"' is not assignable to type 'never'`). Forced through the types, the composed tasks of a group this workflow does not declare run with no limit, and nothing warns. Verified: a workflow declaring `concurrencyLimits: { test: 1 }`, with two tasks of `test` that each sleep 1 s, takes `wall 2.1s` run as its own file and `wall 1.0s` composed into one that declares only `lint`, or no `schedulerOptions` at all. Node names share one namespace: a name both use fails with the duplicate-name error.

Verified example:

```ts
import { defineWorkflow, type Workflow } from "@mrmeku/dagworkflows";

const addTests = (workflow: Workflow<"test">) =>
  workflow.task({ name: "test", cmd: ["npm", "test"], concurrencyGroup: "test" });

export const checks = defineWorkflow({
  schedulerOptions: { concurrencyLimits: { test: 1 } },
  implementation: async (workflow) => ({
    lint: workflow.task({
      name: "lint",
      cmd: ["npm", "run", "lint"],
      inputs: await workflow.glob("src/**"),
    }),
    test: addTests(workflow),
  }),
});

export default defineWorkflow({
  schedulerOptions: { maxParallelism: 4, concurrencyLimits: { test: 2 } },
  implementation: async (workflow) => {
    const { lint, test } = await workflow.compose(checks);
    if (workflow.ctx.ref === "refs/heads/main")
      workflow.task({ name: "publish", cmd: ["npm", "publish"], deps: { lint, test } });
    return workflow.requireAll({ deps: { lint, test } });
  },
});
```

Here `test` runs at most 2 at once (the outer limit), not 1.

`createWorkflow(graph, ports, ctx)` builds the same object over a graph of your own, for tests or for a program that drives dagraph itself.

Where it lives: `workflow.ts`.

## `requireAll`: the required check

`workflow.requireAll({ name?, deps })` adds one action task, named `require-all` unless `name` is given, that depends, settled, on every ref in `deps` (a record keyed by the role each check plays; values are plain refs). It runs once they all settle, whatever they did, and writes `require-all.json` as its `outcome` output: `{ "present": [...], "missing": [...] }`, each a sorted list of roles. If any role is missing (failed, skipped or cancelled; a cached one counts as present), it fails with `failed: <role>, <role>`. It fails rather than being skipped because GitHub counts a skipped check as passing a required one. Its failure is named in every headline and rerun line beside the failures it requires. Point a branch protection rule at this one check instead of each task. Its inputs are `{ version: "require-all:v1" }`, so once it succeeded it is cached while its deps' contents are unchanged. A failed one is never cached and runs again on the next run.

Where it lives: `steps.ts`.

## Post steps (the `post` field)

A task that sets up something that must be undone (a database container, a server) gives its release as `post`, as a GitHub action's `post:` undoes its `main:`. `post` (`PostSpec`) takes:

- `name`: required, unique in the graph (`down:db`);
- its work: `action`, `cmd` or `shell`, exactly one, as a task's; a command post also takes `cwd` and `env`;
- `timeoutMs`;
- `retry`: `"backoff"` (default: after a failed try it tries again after 1000 ms, then 4000 ms, three tries in all, within its own timeout) or `"once"` (one try, for a slow release a retry never helps, such as `terraform destroy`). Each failed try that will be retried writes `Try <n> of 3 failed: <message>. Trying again in <ms> ms.` to the post's log. A cancel or the post's timeout ends the tries at once, even mid-wait, and the last error decides. All tries share one output directory, so a later try sees what an earlier one wrote.

It takes no `deps`, `inputs`, `cacheable` or `outputs`, and a task with a `post` takes no `inputs` or `cacheable` (a cache hit starts nothing, so there would be nothing to release). These do not compile.

The post reads its task's outputs under the role `main`, which a task that failed or was stopped may not have written: in `env` a missing one is unset (`env: ({ main }) => ({ ID: main.id })`, then `if [ -n "${ID:-}" ]; then docker rm -f "$(cat "$ID")"; fi`); in an action, `depOutputs.main` may be `undefined`; it may not be an argument of `cmd`.

In the graph a post depends, settled, on its task, and requires each dep its task requires (under the role `main.<role>`), so it is skipped when its task never started. When a run is assembled, it also waits, settled, for every node downstream of its task, posts of downstream tasks included, so posts run in the reverse order of their tasks, as GitHub's do. Example (verified): `up:db` with post `down:db`, `test` depending on `up:db` and failing: calls are `docker compose up -d`, `npm test`, `docker compose down`; statuses `up:db: done, test: failed, require-all: failed, down:db: done`.

Its work must be safe to do twice. When a post is owed, how a failed or skipped one is paid by the next run, and what a cancel does are [dagworkflows-lifecycle](dagworkflows-lifecycle.md)'s domain.

Where it lives: `post.ts`, `select.ts`.

## Cache and artifact tasks (surface only)

[dagworkflows-cache-artifacts](dagworkflows-cache-artifacts.md) covers these in depth.

- `workflow.cache({ name = "cache", path, key, restoreKeys = [] })` adds `restore:<name>`, which runs every time, tries `key` and then each `restoreKeys` prefix, and has no outputs, so a hit and a miss key its dependents alike. Order tasks after it with `deps: { cas: cas.restore }`. It returns `{ restore, save }`. `save({ partial = "save" | "skip" })` adds `save:<name>`, which waits, settled, for every other node of the run except post steps and other saves, including nodes added after the call. In a run where a task did not succeed it saves under `<key>-partial-<runId>` (or nothing with `partial: "skip"`); only a green run saves under `key`. Call `save()` conditionally to save only on main.
- `workflow.uploadArtifact({ name, artifact, path, deps?, ifNoFilesFound = "warn", overwrite?, retentionDays?, compressionLevel? })` adds a never-cached node named `name` that uploads files as the artifact `artifact`. `path` is a list of globs, or a function of its deps' outputs (handles) returning globs, handles or `undefined` (left out): `deps: { pack }, path: ({ pack }) => ["reports/**", pack.tarball]`. Its globs get the same `DEFAULT_EXCLUDES` as `workflow.glob`, so a glob never uploads anything under `.dag/`, `node_modules/` or `.git/` (such as `.dag/summary.md`); a dep output given as a handle goes up whatever its path, which is how a file from the CAS goes up. Its `response` output, `artifact.json`, holds `{ id, size }` or `null`. Without an artifact service (locally) nothing is uploaded and the log says so.

## Selecting nodes (`--only`)

`dag run <file> --only a,b` (and the action's `only` input) runs part of the graph. The exported `selectNodes(graph, names?, paying = false)` builds that graph:

- the named nodes and everything they depend on, settled deps included;
- plus the post step of every task in it, and the save of every cache restore in it (repeating until nothing more joins);
- each post then waits for the nodes of the selection downstream of its task, and each save for every node of the selection but posts and saves.

Without names, every node is selected. Verified on a graph with a cache `cas`, `up:db` (post `down:db`), `lint` and `test` after `restore:cas`, `test` after `up:db`, and `docs`:

- `--only lint` → `restore:cas`, `lint`, `save:cas` (the save joins because its restore did, and waits for `lint` alone);
- `--only test` → `restore:cas`, `up:db`, `test`, `down:db`, `save:cas`;
- `--only down:db` → `up:db`, `down:db`;
- `--only save:cas` → `restore:cas`, `save:cas`.

`paying: true` builds the graph of a post pass, which pays an earlier run's owed posts: there a post keeps its settled dep on its task and its waits, but requires none of the deps its task requires, since its task did start; so a dep added to the task since the earlier run cannot hold it back.

An unknown name fails the run with `closure: the graph holds no node "nope"`, thrown before any pass, so not even owed post steps run; it reaches the user as an uncaught Node stack trace, exit 1 ([dagworkflows-cli-action-release](dagworkflows-cli-action-release.md), open question 4). The run's banner shows `<n> of <total> nodes (--only a,b)`. In the grouped style and on GitHub, a failed run's last line suggests `reproduce: npx --no dag run <file> --only <failures>`; the local live and failures recaps show the same command as a labelled `rerun` line. It names every failed node, shell-quoted when needed. In the first example that is `--only flaky,require-all`.

`postNodes(graph)` returns a `Map` from each post step's name to its task's name.

Where it lives: `select.ts`, `steps.ts`.

## Using the `@actions` toolkit

The package takes each GitHub Actions idea from the toolkit rather than reimplementing it, so a workflow mostly needs no toolkit import:

- `@actions/glob`: `workflow.glob` and `workflow.hash` (a dependency of the package).
- `@actions/github`'s `context`: `workflow.ctx`.
- `@actions/cache`: the store behind `workflow.cache` on GitHub.
- `@actions/artifact`: the store behind `workflow.uploadArtifact` on GitHub.
- `@actions/exec`: `run`, and the `Exec` port, follow its shape (an argv; no shell unless the argv starts one).
- `@actions/core`: the GitHub host's log groups, annotations and step summary.

`@actions/core`, `@actions/github`, `@actions/cache` and `@actions/artifact` are optional peer dependencies: the CLI loads them on GitHub only; the GitHub action bundles them. Under `GITHUB_ACTIONS=true` the CLI always loads `@actions/core` and `@actions/github` (the GitHub host), so a `dag run` in a `run:` step needs both installed. It loads `@actions/cache` only when `ACTIONS_CACHE_URL` or `ACTIONS_RESULTS_URL` is set, and `@actions/artifact` only when `ACTIONS_RUNTIME_TOKEN` and `ACTIONS_RESULTS_URL` are set. A `run:` step has neither, so there the cache and artifacts are off, each with a notice. A missing peer is named by one template, the same for all four packages:

```
dag needs <package> on GitHub, an optional peer dependency it does not install: add it (npm install --save-dev <package>), or use the action, which bundles it, instead of `dag run`
```

Inside a task, the supported way to talk to GitHub is through the task's log. A node's log is replayed on GitHub inside its own log group, and the runner reads the workflow commands in it as it reads a `run:` step's, so a command that prints `::warning::…`, `::error::…` or `::add-mask::…` works as on GitHub. `warn(message)` writes a warning for you. A tool's own `::group::` lines are flattened into plain lines (GitHub does not nest groups), and a `::stop-commands::` a log leaves open is closed at the end of its group. An action's data goes to later tasks through declared outputs, not through step outputs.

A workflow file that imports a toolkit package itself must have it installed. The GitHub action serves `@mrmeku/dagworkflows` itself from its bundle (so the file loads before `node_modules` exists) but nothing else.

The subpath export `@mrmeku/dagworkflows/github` exposes the GitHub host adapter ([dagworkflows-cli-action-release](dagworkflows-cli-action-release.md)).

Where it lives: `ports/glob.ts`, `ports/github.ts`, `services.ts`, `action/env.ts`, `step-records.ts`.

## Testing a workflow

A workflow can be run in a unit test against in-memory ports: `createTestPorts(opts?)` returns `{ ports, fs, rec, cacheStore, artifactStore }`. Its options, each with its default:

- `exec`: an `Exec` (its `run(argv, opts)` resolves to an `ExecResult`, `{ ended, code, stdout, stderr, output, ok }`); default `okExec`, every command succeeds silently;
- `clock`: default `steppingClock()`;
- `env`: default `{}`, so `workflow.ports.env` is empty in a test;
- `files`: the in-memory file system's seed, text by path;
- `cacheStore`, `artifactStore`: default fresh memory stores;
- `context`: a partial `CiContext` over the recording host's defaults (provider `"recording"`, empty strings, `runId` 0).

The lockfile is an in-memory one. `workflow.glob`, `workflow.hash` and an upload's globs still read the real working directory, not the in-memory fs: a test that globs gets real paths, and their `file()` inputs then fail with `ENOENT` unless `opts.files` seeds the same paths. A node's log is found with `logPath(casBaseDir, actionKey)`.

`runWorkflow({ implementation, ports, casBaseDir, historyDir })` runs it and resolves to `{ results, failed, markdown, cancelled, exitCode }` ([dagworkflows-lifecycle](dagworkflows-lifecycle.md)). It takes `implementation` alone: the definition's `schedulerOptions` and `summary` apply only when passed as options of their own (`schedulerOptions: ci.schedulerOptions`); the CLI and the action copy them from the definition themselves. Passing them field by field (`schedulerOptions: def.schedulerOptions, summary: def.summary`) fails to type-check under `exactOptionalPropertyTypes` (TS2379), because those fields are `T | undefined`; `runWorkflow({ ...def, ports, casBaseDir, historyDir })` type-checks under both settings and passes them when they are set.

The example below was verified with `node --test <file>.test.ts` (plain `node` works too) on Node 24.2 or later, with no flag, in a package with `"type": "module"` (or as a `.mts` file). Under `"type": "commonjs"` it fails with `SyntaxError: Cannot use import statement outside a module`.

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
const outcome = await runWorkflow({
  implementation: ci.implementation,
  ports,
  casBaseDir: "/cas",
  historyDir: "/history",
});
assert.deepEqual(calls, ["docker compose up -d", "npm test", "docker compose down"]);
assert.equal(outcome.exitCode, 1);
```

Other exported doubles: `okExec`, `clockAt(now)`, `steppingClock(start = 0, step = 1000)`, `createRecordingHost(context?)`, `createMemoryCacheStore`, `createMemoryArtifactStore`, `nullHost`, `nullCacheStore`, `nullArtifactStore`.

Where it lives: `ports/memory.ts`.

## Public surface of this domain

`index.ts` is the package's entry point; everything it exports, grouped by the domain that owns it:

- Writing a workflow (this domain):
  - Functions: `defineWorkflow`, `createWorkflow`, `selectNodes`, `postNodes`, `hashFiles(patterns)` (as `workflow.hash`), and, re-exported from dagraph, `file(path)` and `settled(ref)`.
  - Types: `Workflow<G>`, `WorkflowDef<R, G>`, `Implementation<R>`, `GroupsOf<S>`, `TaskSpec`, `ActionTaskSpec`, `CmdTaskSpec`, `ShellTaskSpec`, `PostSpec`, `PostField`, `ActionsCacheSpec`, `ActionsCacheTasks`, `SaveSpec`, `UploadArtifactSpec` (which extends `ArtifactUploadOptions`), `CommandCause`, `CiContext`, `Ports`, `WorkflowPorts`, and from dagraph `NodeRef`, `SettledRef`, `OutputRef`, `SettledOutputRef`.
  - Constants: `DEFAULT_EXCLUDES` (`[".git", "node_modules", ".dag"]`), `DEFAULT_CAS_DIR` (`.dag/cas`).
- Testing doubles (used above): `createTestPorts`, `okExec`, `clockAt`, `steppingClock`, `createRecordingHost`, `RecordedHost`, `createMemoryCacheStore`, `MemoryCacheStore`, `createMemoryArtifactStore`, `MemoryArtifactStore`, `nullHost`, `nullCacheStore`, `nullArtifactStore`, and `logPath`.
- Ports and their real implementations: the types `Exec`, `ExecOptions`, `ExecResult`, `Clock`, `Host`, `Lockfile`, `CacheStore`, `ArtifactStore`, `ArtifactUploadOptions`, `AnnotationLevel`, `CheckUpdate`, and `createExec`, `abortOnSignals`, `systemClock`, `createLocalHost`, `createActionsCacheStore`, `createActionsArtifactStore`, `artifactServiceAvailable` ([dagworkflows-cache-artifacts](dagworkflows-cache-artifacts.md) for the stores, [dagworkflows-cli-action-release](dagworkflows-cli-action-release.md) for the hosts).
- Running and history ([dagworkflows-lifecycle](dagworkflows-lifecycle.md)): `runWorkflow`, `runJob`, `runPost`, `RunOptions`, `RunOutcome`, `createRunHistory`, `readRunHistory`, `runHistoryLive`, `RunHistory`, `RunHistoryFile`, `DEFAULT_HISTORY_DIR`, and the kernel: `RunState`, `RunLifecycle`, `RunAction`, `NodeAction`, `Pass`, `NodeState` and its cases (`PendingNodeState`, `InFlightNodeState`, `SettledNodeState`, `SucceededNodeState`, `FailedNodeState`, `DepFailedNodeState`, `CancelledNodeState`), `selectors`, `createRunStore`, `RunStore`, `RunListener`.
- Output ([dagworkflows-output](dagworkflows-output.md)): `createReporter`, `SummaryRenderer`, `RunReport`, `NodeReport`, `DEFAULT_SUMMARY_RENDERERS`, `renderStatus`, `renderTimeline`, `renderCriticalPath`, `renderDag`, `renderFailures`, `renderTable`, `formatDuration`, `failureMessage`, `DEFAULT_SUMMARY_PATH`.

## Open questions

- `timeoutMs` out of range is refused with the kind, not the task's name: a command reports `action "run": timeoutMs must be a whole number of ms from 1 to 2147483647, got 0`, which does not say which task.
- An input named `command` on a `cmd`/`shell` task is refused only by the types; at runtime it is accepted and silently replaced by the command's own input.
- A post given `outputs` (refused by the types) throws only after its task was already added, leaving the task in the graph without its post.
- The `CiContext` doc comment says locally "the rest is `0` and `""`", but the local `eventName` is `"local"`.
- An action that calls `@actions/core` (or `console.log`) directly writes to the process's stdout, bypassing the node's log, so it is not grouped, not in the log file and not ordered with the node's output. The code gives no guidance on this beyond `log` and `warn`.
- `workflow.ports` is typed without `exec` but at runtime is the full ports object, `exec` included.
- Nodes added straight to `workflow.graph` with a dagraph action write no log file (the log is written by the task wrapper); whether the output layer copes is [dagworkflows-output](dagworkflows-output.md)'s question.
- Two post steps with identical commands, on tasks with no outputs and nothing downstream, have the same action key and so the same log path.
