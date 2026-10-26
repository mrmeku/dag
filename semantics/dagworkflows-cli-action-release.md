# dagworkflows: the `dag` CLI, the GitHub Action, and the dag repository's release

## The problem, and the core idea

A dagworkflows **workflow file** is a TypeScript module that default-exports `defineWorkflow({ ... })`. It describes a CI job as a graph of **nodes**: tasks, cache restores and saves, artifact uploads. (How you write one belongs to the [dagworkflows-workflows](dagworkflows-workflows.md) domain.) Something has to load that file, build the graph, run it with a content-addressed cache, show what happened, and settle up any cleanup it owes. That runner comes in two forms that share one engine:

- the **`dag` CLI**, a Node program you run on a laptop or in any CI step;
- the **GitHub Action**, a JavaScript action that wraps the same runner. GitHub hands a JavaScript action credentials that a plain `run:` step never sees, and it gives the action a `post` entry that runs at the end of the job whatever happened.

The core idea is that one workflow file behaves the same in both places. Locally the runner draws the run in the terminal and writes a summary file. On GitHub it writes workflow commands to the log, writes the step summary, and opens check runs. The graph, the cache and the rules for post steps do not change.

The rest of this page covers the CLI surface, the files a run writes, the action, and how the dag repository itself is developed, exported, tested and released.

Terms used below:

- **CAS**: the content-addressed cache directory, `.dag/cas` by default. It holds each cached node's outputs, keyed by the node's action key (see [dagraph-caching](dagraph-caching.md)).
- **Post step**: a release that a task owes once it has started, such as stopping a database container. It is declared as the task's `post` field. Its rules belong to [dagworkflows-lifecycle](dagworkflows-lifecycle.md). This page covers only how the CLI and the action trigger it.
- **History**: a JSON file, one per run, that records which nodes started and how each settled. A later process reads it to find out which post steps are still owed.
- **Owed**: a post step is owed when its task started and the post step has not yet succeeded.

---

## The `dag` CLI

### Installing and invoking

The package `@mrmeku/dagworkflows` declares a `bin` named `dag`. It is a development dependency of the project whose CI it runs: `npm install --save-dev @mrmeku/dagworkflows`, which brings `@mrmeku/dagraph` (pinned to the same version) and the regular dependencies with it, but not the optional peers `@actions/cache`, `@actions/artifact` and `@actions/github` (the fourth, `@actions/core`, arrives through `@actions/glob`). Locally nothing else is needed; on GitHub use the action, which bundles the peers (see "Local mode and GitHub mode"). As of 2026-10-25, and still on 2026-10-26, the registry answers `404 Not Found` for `@mrmeku/dagworkflows` (no version of it was ever published, while `@mrmeku/dagraph` has `0.1.0` to `0.3.0`, `latest` `0.3.0`). So `npm install --save-dev @mrmeku/dagworkflows` works only once a `v*` release (see "Release") publishes it, and today the package installs only from tarballs made by `scripts/pack.ts`, both given to one install (`npm install --save-dev ./mrmeku-dagraph-<v>.tgz ./mrmeku-dagworkflows-<v>.tgz`; verified with version `0.0.1-test`, after which `npx --no dag run ci.ts` ran). Such an install brings `@actions/glob` and with it `@actions/core`, `@actions/exec`, `@actions/http-client` and `@actions/io`, but not `@actions/cache`, `@actions/artifact` or `@actions/github`. In a project that has it installed, you run it as `npx --no dag <command> <workflow> [options]`. The runner prints this same form in every "rerun" and "reproduce" line, as `npx --no dag run <file>`. Locally the file in those lines is shell-quoted (by the `shlex` library), so a path with spaces stays copy-pasteable. On GitHub it is appended as given, unquoted. Inside the dag repository itself, the scripts call the source directly: `node packages/dagworkflows/src/cli.ts run scripts/ci.ts`.

Badges that read npm's metadata show the same gap. On 2026-10-26 the shields.io version badge `img.shields.io/npm/v/@mrmeku/dagworkflows` renders `npm: invalid` (grey), because npm answers the dist-tags request for a missing scoped package with `401`, not `404`, and the licence badge `img.shields.io/npm/l/@mrmeku/dagworkflows` renders `license: package not found` (red). The same two badges of `@mrmeku/dagraph` render `npm: v0.3.0` and `license: MIT`. Packing keeps each package's `license` field, `MIT` for both, so after the first publish the licence badge reads `MIT` and the version badge the version npm tags `latest`.

Requirements:

- **Node 24.2 or later.** The package's `engines` field says `>=24.2`. On an older Node, or on any runtime without `import.meta.main`, the CLI prints `dag needs Node 24.2 or later` to stderr and exits 1. Node 24.0 and 24.1 lack `import.meta.main`, and without this check they would exit 0 having run nothing. The action makes no such check: see "Which Node runs the action, and which Node its tasks find".
- The workflow file is a `.ts` file that Node loads directly through its built-in type stripping. There is no build step.
- The workflow file must load as an ES module. A `.ts` file does when the nearest `package.json` has `"type": "module"` or no `type` field at all (Node then detects the `import` syntax). Under `"type": "commonjs"`, which `npm init -y` writes, it fails with Node's `SyntaxError: Cannot use import statement outside a module` (after the warning `Failed to load the ES module: <path>. Make sure to set "type": "module" in the nearest package.json file or use the .mjs extension.`), exit 1. Name the file `.mts` (`dag run ci.mts`), or set `"type": "module"`. Verified with the packed tarballs in a fresh `npm init -y` project, on Node 25.8.
- Workflow files import from `@mrmeku/dagworkflows`. That package re-exports what a workflow file needs from the engine (`file`, `settled`, and the types `NodeRef`, `OutputRef`, `SettledRef`, `SettledOutputRef`), so the file need not import `@mrmeku/dagraph`.

The top-level help (`dag --help`) describes the tool as: "Run a CI workflow as a dagraph DAG: on GitHub Actions when GITHUB_ACTIONS=true (workflow commands, step summary, check runs), otherwise locally (terminal output, summary file)." There is no `--version` flag (`error: unknown option '--version'`, exit 1). With no arguments, the CLI prints help and exits 1. `dag help` and `dag help <command>` print help and exit 0, as `-h` and `--help` do.

### Commands

| Command               | Arguments              | What it does                                                              |
| --------------------- | ---------------------- | ------------------------------------------------------------------------- |
| `dag run <workflow>`  | the workflow file path | Execute a workflow file that default-exports `defineWorkflow(...)`.       |
| `dag post <workflow>` | the workflow file path | Run the post steps that the histories of stopped runs show as still owed. |
| `dag help [command]`  |                        | Commander's built-in help. Exits 0.                                       |

Mistakes on the command line are caught by the argument parser (the `commander` library). Each prints one line and exits 1, except that an unknown option close to a known one gets a second line, such as `(Did you mean --cas-dir?)` for `dag post ci.ts --log-dir x`:

- no workflow file: `error: missing required argument 'workflow'`;
- an unknown command, such as `dag bogus`: `error: unknown command 'bogus'`;
- an unknown option: `error: unknown option '--force'`. This includes a `run`-only option given to `post`, since `--force`, `--output-style`, `--log-dir` and `--failures-report-file` exist only on `run`.

A workflow path that does not exist gets past the parser. Its import then fails with Node's `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<absolute path>'`, as an uncaught stack trace, exit 1.

### Options

| Option                          | Commands      | Default                  | Meaning                                                                                                         |
| ------------------------------- | ------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `--force`                       | `run`         | off                      | Ignore the cache for this run. Every node runs and the banner gains ` · force`.                                 |
| `--output-style <style>`        | `run`         | picked from the terminal | Terminal output: one of `live`, `failures`, `grouped`. Also set by the environment variable `DAG_OUTPUT_STYLE`. |
| `--log-dir <dir>`               | `run`         | `.dag/logs`              | Where each node's log is written as it runs.                                                                    |
| `--failures-report-file <file>` | `run`         | `.dag/failures.md`       | Where the report of the run's failures is written.                                                              |
| `--only <names>`                | `run`, `post` | all nodes                | Comma-separated nodes to run, each with its dependencies, plus the post steps of what runs.                     |
| `--cas-dir <dir>`               | `run`, `post` | `.dag/cas`               | The local content-addressed cache directory.                                                                    |
| `--history-dir <dir>`           | `run`, `post` | `.dag/history`           | Where each run records what started and settled, in a history of its own.                                       |
| `--summary-file <file>`         | `run`, `post` | `.dag/summary.md`        | Where the local adapter writes the markdown summary.                                                            |
| `-h, --help`                    | every command |                          | Print the command's help and exit 0.                                                                            |

Every path is relative to the current directory, and so is the workflow file. By convention you run `dag` from the repository root.

#### `--only`

`--only lint,test` runs `lint`, `test` and everything they depend on. It also pulls in the post steps of every task that ends up in the selection, and the cache save of every cache restore in the selection. Empty items are dropped, so `--only lint,` is the same as `--only lint`. The banner shows the scope as `2 of 5 nodes (--only lint,test)`. An unknown name is an uncaught error: the stack trace ends in `closure: the graph holds no node "nope"`, the exit code is 1, and locally `failures.md` records `status: errored`. (The selection rules themselves belong to [dagworkflows-workflows](dagworkflows-workflows.md) and [dagworkflows-lifecycle](dagworkflows-lifecycle.md).)

#### How the output style is chosen (local `run` only)

These rules are checked in order, and the first that applies wins:

1. `--output-style` if given, otherwise `DAG_OUTPUT_STYLE` if set and not empty. An empty `DAG_OUTPUT_STYLE=` counts as unset.
2. Under CI, as detected by the `std-env` library's `isCI` (for example `CI=true`): `grouped`.
3. Under an AI coding agent, as detected by `std-env`'s `isAgent` (for example `CLAUDECODE=1`): `failures`. This holds even in a terminal.
4. When stdout is a terminal and `TERM` is not `dumb`: `live`.
5. Otherwise, for a pipe or a dumb terminal: `grouped`.

The three styles:

- `live` keeps a redrawn footer of running nodes under the scrollback. Colour and hyperlinks are used only in this style, and only when the terminal supports them.
- `failures` prints only failures and a recap, kept within roughly 10,000 characters for an agent's tool output.
- `grouped` prints every node's log as a block, as GitHub groups it.

An invalid style is refused by the argument parser with:

- `error: option '--output-style <style>' argument 'fancy' is invalid. Allowed choices are live, failures, grouped.`
- or, when it comes from the environment: `error: option '--output-style <style>' value 'fancy' from env 'DAG_OUTPUT_STYLE' is invalid. Allowed choices are live, failures, grouped.`

Both exit 1. The exact look of each style belongs to [dagworkflows-output](dagworkflows-output.md).

### Local mode and GitHub mode

The CLI picks its mode from one variable: `GITHUB_ACTIONS=true` means GitHub mode, and anything else means local mode.

**Local mode** (`dag run`):

- **Context.** Workflow files branch on the run's context, `workflow.ctx`. Locally it comes from git: `ref` is `git symbolic-ref HEAD` (`refs/heads/<branch>`), or empty on a detached HEAD or outside a repository. `sha` is `git rev-parse HEAD`, empty outside a repository. In a repository with no commit yet, `git rev-parse HEAD` prints `HEAD` and fails, and the host keeps what it printed without checking the exit code, so `sha` is the string `HEAD`: a cache key `ci-main-${workflow.ctx.sha}` reads `ci-main-HEAD`. `actor` is `git config user.name`, falling back to `$USER`. The other fields are fixed: `isCi: false`, `provider: "local"`, `eventName: "local"`, `runId: 0`, `repo: { owner: "", repo: "" }`, `serverUrl: ""`.
- **Cache store.** The cache store is the _worktree cache store_. A save does nothing, because the files stay on disk. A restore inside a git worktree copies each relative cache path that holds nothing from the same place in the main checkout, and the restore log then reads `Cache restored from: <main checkout path>`. Restore keys are ignored. Details belong to [dagworkflows-cache-artifacts](dagworkflows-cache-artifacts.md).
- **Artifacts.** Artifact uploads do nothing.
- **Session.** A local session draws the terminal in the chosen style and writes the per-node log files, `failures.md` and the summary file.

**GitHub mode** (`dag run` in a `run:` step, or any process with `GITHUB_ACTIONS=true`):

- **Context.** `ref`, `sha`, `eventName`, `actor`, `runId`, `repo` and `serverUrl` come from `@actions/github`'s context. `isCi` is true and `provider` is `github`.
- **Output.** Output goes through `@actions/core`: log groups, annotations as `::notice`, `::warning` and `::error`, and the step summary written to `$GITHUB_STEP_SUMMARY`. If that variable is unset, the summary markdown is printed to the log instead.
- **Check runs.** When `GITHUB_TOKEN` is set, `@actions/github` opens one check run per node. That needs the job permission `checks: write`. On a `pull_request` event the check runs target the pull request's head commit. After the first API failure the checks switch off with the notice `check runs disabled: <reason>`, so a flaky API never fails the build.
- **Cache.** The `@actions/cache` store is used only if the environment has `ACTIONS_CACHE_URL` or `ACTIONS_RESULTS_URL` and the toolkit's `isFeatureAvailable()` agrees. When either check fails, it prints the notice `actions/cache is off: this step cannot reach the cache service; use the action instead of \`dag run\``and runs with no cache service. Every restore misses and every save is a no-op. A`run:`step does not get those variables, so it always takes this path. This holds for`dag post`as for`dag run`: both build their options the same way.
- **Artifacts.** The `@actions/artifact` store is used only if both `ACTIONS_RUNTIME_TOKEN` and `ACTIONS_RESULTS_URL` are set. Otherwise the CLI prints the notice `actions/upload-artifact is off: this step cannot reach the artifact service; use the action instead of \`dag run\``.
- **Local-only options.** No local session runs. `--output-style`, `--log-dir`, `--failures-report-file` and `--summary-file` are accepted but have no effect, and no `.dag/logs`, `failures.md` or `summary.md` is written. Only `.dag/cas` (with `.dag/cas.logs`) and `.dag/history` appear.
- **Peer dependencies.** `@actions/core`, `@actions/github`, `@actions/cache` and `@actions/artifact` are _optional peer dependencies_ of the package: it does not install them. On GitHub the CLI always loads `@actions/core` and `@actions/github` (for the host). It loads `@actions/cache` when `ACTIONS_CACHE_URL` or `ACTIONS_RESULTS_URL` is set, and only then asks its `isFeatureAvailable()`. It loads `@actions/artifact` only when both `ACTIONS_RUNTIME_TOKEN` and `ACTIONS_RESULTS_URL` are set. Off GitHub it never loads `@actions/github`, `@actions/cache` or `@actions/artifact`. It does load the regular dependency `@actions/glob`, and `@actions/core` through it, in either mode, the first time the workflow calls `workflow.glob` or `workflow.hash`. If a peer is missing on GitHub, `dag` fails with: `dag needs @actions/github on GitHub, an optional peer dependency it does not install: add it (npm install --save-dev @actions/github), or use the action, which bundles it, instead of \`dag run\``. The message names whichever package is missing. `@actions/core`usually arrives anyway, through`@actions/glob`.
- **Repository variable.** `@actions/github` takes the repository from `GITHUB_REPOSITORY`, or else from the event payload's `repository` (read from `GITHUB_EVENT_PATH`). Only when both are missing does the run fail with `context.repo requires a GITHUB_REPOSITORY environment variable like 'owner/repo'`.

**Using the CLI on GitHub.** Because a `run:` step cannot reach the cache or artifact services, the supported way to run on GitHub is the action. `dag run` under `GITHUB_ACTIONS=true` exists for CI systems that set the variable, and for tests.

### What `dag run` does, step by step

1. It imports the workflow file. The file must default-export a value made by `defineWorkflow`. If it does not, the run fails with `<file> default-exports no workflow: export default defineWorkflow({ ... })` and exits 1.
2. It builds the graph and applies `--only`.
3. **It pays earlier debts first.** It looks in the history directory for histories of _this_ workflow (matched by the workflow file's resolved path, so `ci.ts` and `./ci.ts` are the same workflow). It skips any whose run is still alive. For each stopped run that still owes post steps, it runs those post steps first. If any of them fails again, no task of this run starts. The run prints the error annotation `No task ran: post steps that an earlier run owes failed again (<n>), and what they release may still be there. Fix them and run again, or, once it is gone, remove that run's history in <history dir>.` and exits 1.
4. It writes its own history file, `<history dir>/<random uuid>.json`, and holds a lock beside it (`<uuid>.json.lock`, a directory) while it runs.
5. It executes the graph against the CAS.
6. When the graph has finished executing, it deletes its history if it owes nothing. If a post step failed, or the run was cancelled before its post steps ran, the history stays for the next pass. A run that never gets here leaves its history behind, whether it owes anything or not. After a second signal (which force-exits) or an error that escapes the engine, the lock is removed (by the lockfile library's exit handler, or by the run's own cleanup), so the next `run` or `post` of the workflow pays what the history owes, or just deletes it, at once. Only a `kill -9` leaves the lock too; it then goes stale after 10 s, and the next pass does the same.
7. It writes the summary and the recap.
8. **After a cancel**, it runs the owed post steps in the same process before exiting, drawn as a second pass titled `post · <k> of <n> post steps owed`.

The banner is the first line of the run. It reads `<file> · ref=<ref> · <n> nodes`, followed by ` · force` if forced. ` · ref=<ref>` is left out when the ref is empty, and one node reads `1 node`. Locally in the `failures` and `live` styles it also ends with ` · report .dag/failures.md` or ` · logs .dag/logs/`.

### What `dag post` does

`dag post <workflow>` does only step 3 of `run`. For each stopped run of this workflow whose history still owes post steps, it runs those post steps. Each pass runs over the same selection that run had, because the history records the run's `--only`. If nothing is owed, it prints nothing and exits 0. If any owed post step fails, it exits 1 and that run's history stays. A history is _stopped_ when its lock is gone or stale. A lock goes stale 10 seconds after the run last refreshed it, which happens after a `kill -9`. A run that is still going is left alone.

**Paying a history renames it.** A pass claims a stopped history by creating a fresh history of its own, `<new uuid>.json` with its own lock, and renaming the old file onto it. It then removes the old lock and records the post pass in the new file. If two passes race for one history, the second rename finds the file gone and that pass skips it. If the post step fails again, the history that stays has the new name, not the original run's. This holds for every pass: `dag post`, the action's post entry, and the debt pass at the start of `dag run` and of the action's main entry.

`dag post` does not use the local session. It always prints in the grouped form, whatever the terminal. It writes `--summary-file` only when it ran at least one pass. With nothing owed it writes no files and creates no directories. It never writes `.dag/logs/` or `failures.md`.

**`dag post` handles no signals.** Neither `dag post` nor the action's post entry installs a signal handler. A Ctrl-C ends the process at once, by the signal itself: no `cancelling` line, no orderly cancel. Commands it has already started keep running, because each runs in a session of its own. If the pass had already claimed a history, that history is under its new name and still owes the post step. Its lock does not stay: the lockfile library's exit handler removes every lock the process holds as the signal ends it. So the next `run` or `post` runs the post step again at once. Only a `kill -9` leaves the lock, which goes stale after 10 s.

### Exit codes

| Code | When                                                                                                                                                                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Every node succeeded or was cached (or, for `post`, nothing owed or every owed post step succeeded).                                                                                                                                                                           |
| 1    | A node failed or was skipped because a dependency failed. Also: an earlier run's owed post step failed again, so no task ran. Also any error that escapes: a bad workflow file, an unknown `--only` name, a missing peer dependency, a too-old Node, an argument-parser error. |
| 130  | `run` only: the run was cancelled by SIGINT, SIGTERM or SIGHUP, as for a Ctrl-C, even if the post steps run after the cancel all succeeded. (`post` is killed by the signal itself, so a shell reports 128 plus the signal number, which is 130 for SIGINT.)                   |

**Signals.** On the first SIGINT, SIGTERM or SIGHUP, `dag run` prints `<SIGNAL>: cancelling, waiting for running commands to stop`. It interrupts the running commands, lets waiting nodes settle as cancelled, runs the owed post steps, and exits 130. A second signal kills every running command's process group with SIGKILL and exits 130 at once. The post steps it owes are then left for the next `run` or `post`. Locally `failures.md` then says `status: interrupted` and `A forced exit stopped the run.` A Ctrl-C while the workflow file is still being imported ends the process by the signal itself, before any handler is installed. How cancels propagate to commands belongs to [dagworkflows-lifecycle](dagworkflows-lifecycle.md).

### Environment variables

| Variable                                                                                                                                        | Read by                        | Effect                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_ACTIONS`                                                                                                                                | CLI                            | `true` selects GitHub mode. When it is not set, the `::debug::` lines that `@actions/glob` prints are dropped from stdout.                    |
| `GITHUB_TOKEN`                                                                                                                                  | CLI (GitHub mode), action      | Enables check runs (needs `checks: write`).                                                                                                   |
| `GITHUB_STEP_SUMMARY`                                                                                                                           | GitHub host                    | The file the step summary is appended to. If it is unset, the summary is printed to the log.                                                  |
| `GITHUB_REPOSITORY`, `GITHUB_REF`, `GITHUB_SHA`, `GITHUB_EVENT_NAME`, `GITHUB_ACTOR`, `GITHUB_RUN_ID`, `GITHUB_SERVER_URL`, `GITHUB_EVENT_PATH` | `@actions/github` context      | The run's context: ref, sha, event, repository, and the pull request head used for check runs.                                                |
| `ACTIONS_CACHE_URL`, `ACTIONS_RESULTS_URL`                                                                                                      | CLI (GitHub mode), action      | Either one lets `dag run` and `dag post` try the cache service. The action reads them only through `@actions/cache`'s `isFeatureAvailable()`. |
| `ACTIONS_RUNTIME_TOKEN` and `ACTIONS_RESULTS_URL`                                                                                               | CLI (GitHub mode only), action | Both present means artifact uploads are on.                                                                                                   |
| `DAG_OUTPUT_STYLE`                                                                                                                              | CLI `run`, local               | Sets the output style, as `--output-style` does (the flag wins). An empty value is ignored.                                                   |
| `CI` and the other CI markers `std-env` knows                                                                                                   | CLI, local                     | Make the automatic style `grouped`.                                                                                                           |
| Agent markers `std-env` knows (e.g. `CLAUDECODE`)                                                                                               | CLI, local                     | Make the automatic style `failures`.                                                                                                          |
| `TERM`                                                                                                                                          | CLI, local                     | `dumb` turns `live` off and gives `grouped`.                                                                                                  |
| `USER`                                                                                                                                          | local host                     | The fallback actor when git has no `user.name`.                                                                                               |
| `INPUT_<NAME>`                                                                                                                                  | action                         | The action's inputs, as the runner passes them.                                                                                               |
| `ACTION_DEPLOY_KEY`                                                                                                                             | `scripts/release-action.ts`    | The SSH deploy key used to push the action repository.                                                                                        |

Every command a node runs inherits the whole process environment, with the node's own `env` merged on top. On GitHub that includes the runner's credentials and the action's `INPUT_*` variables.

### The library entry points behind each surface

`@mrmeku/dagworkflows` exports the functions the CLI and the action call, so another program can run a workflow the same way:

- `runJob(options, processEvents)` is `dag run`: the run, then the post pass after a cancel, then the store's close. It resolves to the exit code.
- `runWorkflow(options)` is the action's main entry: the debt pass and the run, with no post pass after a cancel.
- `runPost(options)` is `dag post` and the action's post entry. It takes the same options without `force` and `signal`.

The options (`RunOptions`) are the workflow's `implementation`, `schedulerOptions` and `summary`; the engine's `force` and `signal`; and `workflowFile`, `ports`, `casBaseDir`, `historyDir`, `only`, `rerunCommand` (by default `npx --no dag run` and the file; a value given replaces the whole command, file included, and is used only in the recap's `reproduce:` line, while the local terminal's and `failures.md`'s `rerun` lines always use `npx --no dag run` and the quoted file. The CLI's local session always sets its own.) and `store` (by default the GitHub renderer on `ports.host`). The outcome (`RunOutcome`) holds `results`, `failed`, `markdown`, `cancelled` and `exitCode` (130 after a cancel, else 1 when a node did not succeed, else 0). The history format described below is exported as `RunHistoryFile` (and its `results` as `RunHistory`), with `createRunHistory`, `readRunHistory` and `runHistoryLive`.

### A worked example

This example ran as written, in a fresh git repository, using tarballs packed from this tree and installed with `npm install --save-dev`. Its only source file, `src/index.js`, is the single line `console.log("hi")`, which is the `hi` that `test` prints. On 2026-10-26 it ran again in a fresh repository on branch `master`, on Node 25.8.1, with the package resolved from this tree and the CLI run from source (`node packages/dagworkflows/src/cli.ts run ci.ts` with `DAG_OUTPUT_STYLE=grouped`). The first run printed the output below except for timings, the second the cached recap after it, and both exited 0.

```ts
// ci.ts
import { defineWorkflow } from "@mrmeku/dagworkflows";

export default defineWorkflow({
  implementation: async (workflow) => {
    const src = await workflow.glob("src/**");
    const lint = workflow.task({
      name: "lint",
      cmd: ["node", "--check", "src/index.js"],
      inputs: { version: "lint-v1", ...src },
    });
    workflow.task({
      name: "test",
      shell: "node src/index.js",
      inputs: { version: "test-v1", ...src },
      deps: { lint },
    });
  },
});
```

`npx --no dag run ci.ts` in a pipe (the `grouped` style), on branch `master`:

```
▶ ci.ts · ref=refs/heads/master · 2 nodes
    lint
    test
▷ lint
▶ ✔︎ lint (38ms)
▷ test
▶ ✔︎ test (47ms)
    hi
summary: .dag/summary.md

✔︎ all 2 nodes succeeded · ci.ts · built 2 · cached 0 · failed 0 · skipped 0 · wall 86ms
```

Exit 0. Run it again and every node is a cache hit: `✔︎ all 2 nodes succeeded · ci.ts · built 0 · cached 2 · failed 0 · skipped 0 · wall 3ms`. `--force` builds both again.

When a node fails, here a shell task `lint` that runs `echo linting; cat src/missing.txt`, the grouped output ends:

```
▶ ✖︎ lint (9ms)
    linting
    cat: src/missing.txt: No such file or directory
    ── error ──
    its shell command exited 1
[error] lint: its shell command exited 1
⏭︎ test: skipped, dependency lint failed
summary: .dag/summary.md

✖︎ lint failed · ci.ts · built 0 · cached 0 · failed 1 · skipped 1 · wall 9ms
failed: lint
skipped, dependency failed: test
reproduce: npx --no dag run ci.ts --only lint
```

Exit 1. `.dag/failures.md` then holds:

````
# Failures · ci.ts

status: finished · started 2026-10-25T17:12:45.112Z · wall 0.0s
✖︎ lint failed · built 0 · cached 0 · failed 1 · skipped 1

## ✖︎ lint · exit 1 · 0.0s · 2 lines

- command: `bash --noprofile --norc -eo pipefail -c 'echo linting; cat src/missing.txt'` (cwd `.`)
- log: `.dag/logs/lint.log` (2 lines)
- skipped because of it: `test`
- rerun: `npx --no dag run ci.ts --only lint`

```text
linting
cat: src/missing.txt: No such file or directory
```

Logs: .dag/logs/ · summary: .dag/summary.md
````

**A post step after a cancel.** Take a task `up:db` with `post: { name: "down:db", shell: "..." }` and a slow task that depends on it. Press Ctrl-C while the slow task runs. The run cancels the slow task, then runs a second pass that prints `▶ post · 1 of 1 post steps owed` and `▶ ✔︎ down:db`, and exits 130. If you kill the same run with `kill -9` instead, its history stays in `.dag/history/<uuid>.json` with its lock. Within the first 10 seconds, `dag post ci.ts` prints nothing and exits 0, because the run might still be alive. After that, it runs `down:db` and deletes the history.

---

## The files a run writes

All paths below are the defaults. Each one moves with its option.

| Path                                  | Content                                                                                                                                                                                                                                                                                              | Written by                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `.dag/cas/`                           | The outputs of each cached node, one directory per action key (`<key>/manifest.json` plus output files). This is the directory to cache between runs.                                                                                                                                                | `run`, `post`, action               |
| `.dag/cas.logs/<key>.log`             | The log of each node, keyed by its action key, _beside_ the CAS and never in it. A cached node shows the log of the run that built it. Never cache this directory: a pull request could restore it, and nothing masks what a command printed. The location follows `--cas-dir`: `X` gives `X.logs/`. | `run`, `post`, action               |
| `.dag/cas/last-run.json`              | `{ "durations": { "<node>": <ms>, ... } }`: each node's time in the last run. The live footer and the step summary compare with it. It sits inside the CAS on purpose, so a saved cache carries it.                                                                                                  | `run`, `post`, action               |
| `.dag/history/<uuid>.json`            | One run's history: `{ "workflow": "<resolved path of the workflow file>", "only"?: [...], "started": [node names in start order], "results": { "<node>": <the engine's Result> } }`. It is deleted when the run owes nothing. A pass that pays it moves it to a new uuid.                            | `run`, `post`, action main and post |
| `.dag/history/<uuid>.json.lock`       | The run's lock, a directory, refreshed while the run lives and stale 10 s after it stops.                                                                                                                                                                                                            | `run`, `post`, action main and post |
| `.dag/history/<uuid>.json.<uuid>.tmp` | A history write in progress, renamed over the file when it is complete. A leftover one from a killed write is deleted by the next pass.                                                                                                                                                              | `run`, `post`, action main and post |
| `.dag/logs/<node>.log`                | Local `run` only: each node's log as it arrives, so `tail -F` follows it. Each `:` or `/` in a node name becomes a directory, so `restore:cas` is `.dag/logs/restore/cas.log`. A segment of `.` or `..` is encoded as `%2E`.                                                                         | local `run`                         |
| `.dag/failures.md`                    | Local `run` only: the report of the last run's failures. It is rewritten as each pass begins, as nodes fail, at the end, and on a forced exit.                                                                                                                                                       | local `run`                         |
| `.dag/summary.md`                     | Local `run` and `post`: the markdown step summary that GitHub would show. Within one process the post pass appends to the run's summary. A new process replaces the file.                                                                                                                            | local `run`, `post`                 |

**History details.**

- A stopped history that cannot be read is deleted with its lock, and the warning `ignoring the run's history <path>: <reason>. The post steps it owed do not run.` The reason is one of three:
  - the JSON object has no `started` key (a history from an older dag): `it records no started nodes, as a history from before dag recorded them`;
  - any other field is missing or ill-typed (`workflow` not a string, `only` not a list of strings, `results` not engine results): `not a run's history: it lacks its workflow, started nodes or results`;
  - the file is not valid JSON: the JSON parser's own message, such as `Expected property name or '}' in JSON at position 1 (line 1 column 2)`.
- A stopped history that owes nothing is deleted with its lock, silently.
- A history that belongs to another workflow file is left for that workflow.
- If a run loses the lock on its history while it runs, Node prints the warning `the lock on <path> was lost: <reason>` and the run goes on. A concurrent `run` or `post` may then take it for stopped and pay its post steps while it is still going. A local cache restore's lock in a worktree warns the same way.
- Two runs in the same directory at the same time each write their own history, so neither disturbs the other.

**Failed writes.** If writing the log files or `failures.md` fails, for example on a full disk, the recorder prints one warning, `log files off: <reason>` or `failures report off: <reason>`, and stops recording. The run goes on.

`.dag/` is in `DEFAULT_EXCLUDES`, along with `.git` and `node_modules`, so `workflow.glob` never hashes the runner's own files and an artifact pattern never uploads them. `workflow.hash` and cache paths do not apply these excludes.

**Keeping them out of git.** dagworkflows writes no `.gitignore` of its own: after a first local run, `git status` lists `?? .dag/`. Every default path sits under `.dag/`, so the one line `.dag/` in the project's `.gitignore` covers them all, as the dag repository's own `.gitignore` does. A path moved out of `.dag/` with `--cas-dir`, `--history-dir`, `--log-dir`, `--failures-report-file` or `--summary-file` needs its own line (and for `--cas-dir X`, `X.logs/` too). Moving the CAS out of `.dag` also takes it out of `DEFAULT_EXCLUDES`, so a broad `workflow.glob` or artifact pattern can then hash or upload it.

The package exports `DEFAULT_CAS_DIR` (`.dag/cas`), `DEFAULT_HISTORY_DIR` (`.dag/history`), `DEFAULT_SUMMARY_PATH` (`.dag/summary.md`) and `DEFAULT_EXCLUDES` (`[".git", "node_modules", ".dag"]`). The log directory and failures report defaults are internal.

Where it lives: `packages/dagworkflows/src/cli.ts`, `config.ts`, `runner.ts`, `history.ts`, `services.ts`, `local/session.ts`, `local/recorders/*.ts`, `ports/local.ts`, `ports/github.ts`, `step-records.ts`; tests `cli.test.ts`, `services.test.ts`.

## Fixed values

Every tunable number of the runner is a constant in `packages/dagworkflows/src/config.ts`. None is read from an option, an input or the environment: changing one means changing that file. The only exceptions are the paths with an option (above) and the three delays that `createExec({ sigintGraceMs, sigtermGraceMs, streamDrainGraceMs })` takes, for a program that builds its own ports. The values a user meets:

| Value                                                                                                                                                      | What it governs                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.dag/cas`, `.dag/history`, `.dag/summary.md` (exported `DEFAULT_CAS_DIR`, `DEFAULT_HISTORY_DIR`, `DEFAULT_SUMMARY_PATH`); `.dag/logs`, `.dag/failures.md` | Default paths.                                                                                                                                                                                                                                                  |
| `npx --no dag run`                                                                                                                                         | The start of every `rerun` and `reproduce:` line, before the workflow file. `RunOptions.rerunCommand` replaces the default `reproduce:` command whole, file included; the local `rerun` lines keep this one.                                                    |
| `[".git", "node_modules", ".dag"]` (exported `DEFAULT_EXCLUDES`)                                                                                           | Directories that `workflow.glob` and the path patterns of `workflow.uploadArtifact` leave out, as `!**/<dir>/**`. `workflow.hash` (`hashFiles`) and `workflow.cache` paths do not leave them out.                                                               |
| 10,000 ms                                                                                                                                                  | A history lock not refreshed this long is stale: its run was killed.                                                                                                                                                                                            |
| 2,000 ms, then 1,000 ms                                                                                                                                    | A cancelled or timed-out command gets SIGINT, SIGTERM 2 s later, SIGKILL 1 s after that. Chosen to settle within the 7.5 s GitHub leaves between its SIGINT and SIGTERM.                                                                                        |
| 1,000 ms                                                                                                                                                   | How long a background process may hold a finished command's output open.                                                                                                                                                                                        |
| 1,000 ms, 4,000 ms                                                                                                                                         | A post step's waits between its three tries (`retry: "backoff"`).                                                                                                                                                                                               |
| `-partial-`                                                                                                                                                | Between the key and the run id in a partial cache save.                                                                                                                                                                                                         |
| 100 ms                                                                                                                                                     | How often a local worktree restore retries a lock another restore holds.                                                                                                                                                                                        |
| 40 lines, else the last 20                                                                                                                                 | A failure block's log in the terminal. (This and the output limits below, down to the 900,000 bytes, belong to [dagworkflows-output](dagworkflows-output.md); in the published docs the output page owns them, and the reference page's table leaves them out.) |
| 500 characters                                                                                                                                             | A terminal line is cut here (log files keep it whole).                                                                                                                                                                                                          |
| 24 columns                                                                                                                                                 | Names pad to the longest in the run, up to this width.                                                                                                                                                                                                          |
| 500 ms, then every 100 ms                                                                                                                                  | When the `live` footer first appears, and how often it redraws.                                                                                                                                                                                                 |
| 8 rows (and at most half the window), 72 columns (at least 10)                                                                                             | The `live` footer's largest size.                                                                                                                                                                                                                               |
| 80 × 24                                                                                                                                                    | The terminal size assumed when stdout gives none.                                                                                                                                                                                                               |
| 2                                                                                                                                                          | Waiting nodes the footer lists, and dependencies it names for each.                                                                                                                                                                                             |
| 3 blocks, 4,000 / 7,000 / 1,000 characters, 3 warnings per node                                                                                            | The `failures` style's limits: failures drawn as blocks, the tails' budget, the output budget, the warnings' budget.                                                                                                                                            |
| 5                                                                                                                                                          | Nodes a recap names under one failure before `+N`.                                                                                                                                                                                                              |
| 65,000 characters                                                                                                                                          | The tail of a check run's summary kept (GitHub refuses over 65,535).                                                                                                                                                                                            |
| 60 nodes                                                                                                                                                   | Above this, the summary's graph draws one box per kind.                                                                                                                                                                                                         |
| 60 lines                                                                                                                                                   | Log lines in the summary's failure blocks and in `failures.md`.                                                                                                                                                                                                 |
| 900,000 bytes                                                                                                                                              | The step summary's budget (GitHub caps it at 1 MiB).                                                                                                                                                                                                            |
| 1,000 ms                                                                                                                                                   | Nodes shorter than this are left out of the critical path.                                                                                                                                                                                                      |
| `last-run.json`                                                                                                                                            | The durations file inside the CAS directory.                                                                                                                                                                                                                    |

Where it lives: `packages/dagworkflows/src/config.ts`, `src/ports/real.ts` (`createExec`).

---

## The GitHub Action

### What it is

The action is `packages/dagworkflows/action/action.yml`, named `dagworkflows`. Its description reads: "Run a CI workflow as a dagraph DAG, with actions/cache restore and save and actions/upload-artifact as nodes in the graph." It runs `using: node24` with two entries:

- `main: dist/main.js` runs the workflow.
- `post: dist/post.js` runs at the end of the job whatever became of main, and pays the post steps the run still owes.

`dist/` is build output and is never committed. `bun run build:action` makes it by bundling `src/action/main.ts` and `src/action/post.ts` with `bun build --target=node --format=esm` into `packages/dagworkflows/action/dist/`. Each bundle is about 3.6 MB and inlines all of `@actions/*`. A test (`bundle-safe.test.ts`) ensures the bundle never reaches the local terminal or recorders, or the libraries only they use (`std-env`, `shlex`, `string-width`, `supports-hyperlinks`).

### Inputs

| Input         | Default        | Meaning                                                                                                                                                                    |
| ------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow`    | (required)     | Path to the workflow file that default-exports `defineWorkflow(...)`.                                                                                                      |
| `cas-dir`     | `.dag/cas`     | Local content-addressed cache directory.                                                                                                                                   |
| `history-dir` | `.dag/history` | Where each run records what started and settled, in a history of its own, for the post step.                                                                               |
| `force`       | `"false"`      | Ignore the cache for this run. It is read as a YAML boolean (`true`/`True`/`TRUE`/`false`/`False`/`FALSE`). Any other value makes `@actions/core` throw and the step fail. |
| `only`        | (empty)        | Comma-separated nodes to run, each with its dependencies, plus the post steps of what runs.                                                                                |

Both entries read every input. Without `workflow`, `@actions/core` throws `Input required and not supplied: workflow`. An empty `cas-dir` or `history-dir` means the default. An invalid `force` fails the post entry as well as main (exit 1), even though `force` has no effect there, so the owed post steps do not run either.

The action has no outputs. The run's results appear in the log groups, the step summary, one check run per node (when `GITHUB_TOKEN` is set and the job has `checks: write`), and the annotations.

### How it maps to the CLI

| Action                           | CLI                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow` input                 | the `<workflow>` argument                                                                                                                                           |
| `cas-dir`, `history-dir`, `only` | `--cas-dir`, `--history-dir`, `--only`                                                                                                                              |
| `force: true`                    | `--force`                                                                                                                                                           |
| `main` entry                     | `dag run` in GitHub mode, except that the main entry does _not_ run the post pass after a cancel. It exits 130 and leaves the owed post steps to the post entry.    |
| `post` entry                     | `dag post`. `force` is still parsed (and an invalid value fails the step) but changes nothing. `only` is parsed and ignored: the selection comes from each history. |
| (none)                           | `--output-style`, `--log-dir`, `--failures-report-file`, `--summary-file`: there is no local session on GitHub                                                      |

Unlike `dag run` in a `run:` step:

- **Services.** The runner gives a JavaScript action's process the cache service URL and the runtime token. So the action uses `@actions/cache` whenever `isFeatureAvailable()` is true, and `@actions/artifact` whenever both `ACTIONS_RUNTIME_TOKEN` and `ACTIONS_RESULTS_URL` are present. When a service is unavailable (for the cache, when `isFeatureAvailable()` is false, whatever the variables), only the main entry prints a notice, so it appears once per job: `actions/cache is off: no cache service in this environment` or `actions/upload-artifact is off: no artifact service in this environment`.
- **No install needed.** The workflow file can load before `npm install` or `bun install` has run. The action registers a module-resolution hook that answers `@mrmeku/dagworkflows` with the running bundle itself. So a checkout followed by the action is enough to load the workflow file, and installing dependencies can be a cached node of the graph like any other. Only that exact bare specifier is served. Any other package the workflow file imports at runtime, the subpath `@mrmeku/dagworkflows/github` and `@mrmeku/dagraph` included, must already be in `node_modules`. Imports of relative `.ts` files work.
- **Errors.** An error that escapes either entry is printed to stderr and the step exits 1. Otherwise the step's exit code is the run's: 0, 1 or 130 for main, and 0 or 1 for post.

**Cancels on GitHub.** GitHub sends the main step SIGINT, then SIGTERM 7.5 s later. The first signal cancels the run. The second, if the run has not settled by then, kills what is still running and exits. GitHub then runs the post entry, which pays the owed post steps from the history. Only owed post steps start after a cancel. A post step the post entry cannot pay (it fails its three more tries, or the entry skips a killed main whose lock is still fresh, open question 3) stays owed only in the runner's workspace. On a GitHub-hosted runner that goes with the VM, so no later run pays it: see "When a debt outlives the job" in [dagworkflows-lifecycle](dagworkflows-lifecycle.md).

### Which Node runs the action, and which Node its tasks find

The runner runs both entries on a Node of its own, `externals/node24/bin/node` in the runner's directory, whatever Node the job has set up. That Node also loads the workflow file, so a `.ts` workflow file loads the same with or without `actions/setup-node`.

**That Node is 24.2 or later.** GitHub's runner (`github.com/actions/runner`) pins it in `src/Misc/externals.sh`. The first runner able to run `using: node24`, v2.327.0 (2025-07-22), ships Node 24.4.0. v2.338.2, released 2026-10-26, ships 24.22.1. An older runner refuses the action with `'using: node24' is not supported, use 'docker', 'node12', 'node16' or 'node20' instead.`

**The action checks no version.** Neither entry prints `dag needs Node 24.2 or later` or reads `import.meta.main`. What it needs of Node is `module.registerHooks` (added in Node 22.15 and 23.5), for the resolve hook. One case gives a `node24` action an older Node: on a self-hosted Linux ARM32 runner, the runner falls back to its Node 20 with the warning `Node 24 is not supported on Linux ARM32 platforms. Falling back to Node 20.` (a deprecation warning instead, when GitHub turns that on). When GitHub turns on its kill switch, the step fails instead with `Linux ARM32 runners are no longer supported. Please migrate to a supported platform.` Under Node 20 both entries fail as they load, before any notice, with `SyntaxError: The requested module 'node:module' does not provide an export named 'registerHooks'`, exit 1. Nothing runs, so nothing is owed. This was checked on 2026-10-26 by running both bundles under Node 20.20.2.

**A task's commands do not run on that Node.** A `cmd` or `run` program, and the `bash` of a `shell` task, is looked up by name on the step's `PATH`, with the step's environment (see [dagworkflows-workflows](dagworkflows-workflows.md)). The runner does not put its own Node on that `PATH`. It prepends only what earlier steps added through `GITHUB_PATH`, as `actions/setup-node` and `oven-sh/setup-bun` do. So `node`, `npm` and `npx` in a task are the runner machine's, unless an earlier step set up others. This was checked on 2026-10-26 by running the bundled main entry under one Node with another `node` first on `PATH`: a `cmd` task's `node --version` and a `shell` task's `command -v node` both ran the one on `PATH`.

What a GitHub-hosted image puts on `PATH` is GitHub's (`github.com/actions/runner-images`) and changes over time. On 2026-10-26:

- `ubuntu-latest` is Ubuntu 24.04 (image 20261023.334.3): Node.js 22.23.3 and npm 10.9.9. Node 24.21.0 is only in the tool cache, where `actions/setup-node` finds it without a download. GitHub has announced that `ubuntu-latest` moves to Ubuntu 26.04 in November 2026. That image (20261023.163.3) has Node.js 24.21.0 and npm 11.19.0.
- `macos-latest` is macOS 26 on arm64 (image 20261013.0424.1): Node.js 24.21.0, npm 11.19.0 and Bash 3.2.57.
- Neither has Bun, nor does `windows-latest` (Windows Server 2025).

So the action itself needs no setup step. Whether a job needs `actions/setup-node` depends on what its tasks need of the machine's Node. Today a task that needs Node 24 on `ubuntu-latest`, or Bun on any hosted image, needs a setup step before the action. On a self-hosted runner, the machine's `PATH` decides. The dag repository's CI and release add `actions/setup-node@v4` with `node-version: 24` and `oven-sh/setup-bun@v2` with `bun-version: 1.4.2` before the action, because their tasks run `node` and `bun`.

### Where it is published, and how consumers reference it

The release pushes build output only to the repository `github.com/mrmeku/dagworkflows`. That repository holds `action.yml`, `dist/main.js`, `dist/post.js`, `README.md` and `LICENSE`, and nothing else. It carries three refs:

- `main`: the release that ran last, not the highest version. Each release commits on top of the existing `main`.
- `v<version>` (e.g. `v1.2.3`): meant to pin one release. The release force-moves it just as it moves `v<major>`, so re-running the release of a version without a cache hit on `release:action` re-points it to a new commit.
- `v<major>` (e.g. `v1`): a moving tag, as `actions/checkout@v4` has, that follows the release of that major that ran last, whatever the version order. Releasing `0.2.1` after `0.3.0` moves both `main` and `v0` back to `0.2.1`, and a prerelease moves them too. (The header comment of `release-action.ts` says "follows the newest", which is imprecise in the same way.)

The release pushes a commit and tags only, never a GitHub release. The action has no GitHub Marketplace listing: on 2026-10-25 `github.com/marketplace/actions/dagworkflows` and `.../dagactions` both answer 404, and `mrmeku/dagworkflows` has no GitHub releases, which a listing requires.

**Issues and pull requests on `mrmeku/dagworkflows`.** No code handles them. The release replaces the repository's whole tree with the five files above, so it holds no `.github/` and runs no workflow: unlike on `mrmeku/dag`, nothing closes a pull request opened there. The repository's settings are made outside this repository. On 2026-10-26 the GitHub API shows:

- issues enabled, and wiki, projects and discussions off. No issue or pull request has ever been opened.
- the description "The dagworkflows GitHub action, build output only. Source: github.com/mrmeku/dag".
- two rulesets, `main: export only` on `refs/heads/main` and `releases: export only` on `refs/tags/v*`. Each restricts creation, update, deletion and non-fast-forward pushes, and only a deploy key may bypass it. The one deploy key is `release-to-dagworkflows`, with write access, the key the release pushes with. So no one can merge a pull request there.

A file that did reach `main` would be removed by the next release, which empties the tree before it copies the five files in. `CONTRIBUTING.md`, which sends bug reports and fixes to the issues of `mrmeku/dag`, is not among those files. Whether anyone reads the issues opened on `mrmeku/dagworkflows` is not settled: see Open questions.

A consumer's job:

```yaml
name: ci
on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read
  checks: write # one check run per node

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mrmeku/dagworkflows@v1
        with:
          workflow: ci.ts
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

The refs that exist today (checked with `git ls-remote` on 2026-10-25, unchanged on 2026-10-26) are `main`, `v0`, `v0.1.1`, `v0.2.0` and `v0.3.0`, with `v0` = `v0.3.0` = `main` (commit `5031056`). None of them runs this action. Every one was released from the earlier package `dagactions`: its `action.yml` is `name: dagactions` with the inputs `workflow`, `cas` (default `.dagactions/cas`), `journal` (default `.dagactions/journal.json`), `force` and `only`, and its bundle's resolve hook serves only `@mrmeku/dagactions` and reads the workflow from `def.workflow`. A dagworkflows workflow file under `@v0` therefore fails (with the package installed, as `TypeError: opts.workflow is not a function`). The consumer job above, with `cas-dir`/`history-dir` and a workflow file importing `@mrmeku/dagworkflows`, works only from the first release cut from the current code. A commit SHA is the only ref no release can move.

The code does not set the version of that release. It comes only from the pushed `v*` tag; no `package.json` has a `version` field. So which major ships, and so whether a consumer writes `@v0` or `@v1`, is the owner's decision when tagging. The example above uses `@v1`, and so does every example of `uses: mrmeku/dagworkflows` in these documents: it stands for the major the first release from this code takes. `@v0` is right only for a 0.x release. What the code does settle is what each choice does, and which versions are already taken:

- A 1.x release creates `v1` and moves `main`, and leaves `v0` on the `dagactions` build. Until one runs, the example's `@v1` names no ref of `mrmeku/dagworkflows`.
- A 0.x release moves `v0` and `main` off the `dagactions` build, so a job that still uses `@v0` gets the new action, with its new inputs, at its next run.
- The version must be one `@mrmeku/dagraph` has never published. On 2026-10-26 the registry holds `0.0.0-stage`, `0.1.0`, `0.1.1`, `0.2.0` and `0.3.0`. For one of those, `publish:dagraph`'s `npm view @mrmeku/dagraph@<version> version` succeeds, so it skips the publish, and `@mrmeku/dagworkflows@<version>` is published pinned to the engine published under that version earlier, not the one in the tree. (`npm view` of a version npm lacks exits 1, `404 No match found for version <version>`, so a new version does publish.) The dag repository already has the tags `v0.1.1`, `v0.2.0` and `v0.3.0`.

Which major the first release takes is still open: see open question 10.

Within the dag repository, CI uses the action from source instead. It runs `bun run build:action` first and then `uses: ./packages/dagworkflows/action`.

The CAS only survives between jobs if the workflow file caches it. Typically it calls `workflow.cache({ name: "cas", path: [".dag/cas"], key, restoreKeys })`, makes the checks depend on `cas.restore`, and calls `cas.save()`. If you change `cas-dir`, change that `path` to match.

Where it lives: `packages/dagworkflows/action/action.yml`, `src/action/env.ts`, `src/action/main.ts`, `src/action/post.ts`, `src/ports/cache-store.ts`, `src/ports/artifact-store.ts`, `src/ports/real.ts` (how a command is started), `src/bundle-safe.test.ts`, `scripts/release-action.ts`. The runner's Node and the hosted images' tools are GitHub's: `github.com/actions/runner` and `github.com/actions/runner-images`.

---

## The dag repository

### What it is and where it comes from

The public repository `github.com/mrmeku/dag` is a **read-only export** of an upstream source. `CONTRIBUTING.md` and `LICENSE` sit at its root (the GitHub API listing of `mrmeku/dag` confirms them). `release-action.ts` copies that root `LICENSE` into the action repository. `CONTRIBUTING.md` says:

- Every commit on its `main` is made by an export job, and its `v*` tags are made by the release. The second half is wrong: the export force-pushes each upstream `v*` tag to `mrmeku/dag` (step 3 below), and that tag starts dag's release, which pushes tags only to `mrmeku/dagworkflows`.
- Pull requests are closed automatically by the `pull requests` workflow. It runs on `pull_request_target` (opened or reopened), comments "Thanks. This repository is a read-only export, so pull requests are closed automatically; see CONTRIBUTING.md for how a change gets in.", closes the PR, and never checks out the PR's code.
- Bug reports and feature requests go in issues. A fix goes in an issue as a patch or a link to a branch. It is applied upstream, arrives with the next export, and is credited in the release notes. No release notes exist anywhere, and nothing writes any: see Open questions. Nor does any commit name the contributor. The export's squashed commit is authored `export` with the message `Export <sha>` and no trailer, so an upstream commit's author never reaches `mrmeku/dag` (on 2026-10-26 the GitHub API shows all 31 of its commits by `export`), and each action release is a commit by `dagworkflows release`. So nothing the code writes credits a contributor anywhere.

**The export** runs upstream on every push to `main` and every `v*` tag:

1. It copies the repository without `node_modules`, `.dag` and `action/dist`, with a `bun.lock` that holds only dependency versions resolved and tested upstream.
2. It commits the result as one squashed commit `Export <first 12 chars of sha>` by `export <export@users.noreply.github.com>`, but only if something changed (otherwise it prints `nothing new to export`), and pushes it to `main`.
3. On a tag, it force-pushes the same tag name to `mrmeku/dag`, which starts that repository's release workflow.

### Layout and tools

The root `package.json` is the private workspace `dag`, with workspaces `packages/*`:

- `packages/dagraph`: the package `@mrmeku/dagraph`, the generic DAG engine. Its exports are `.`, `./fs`, `./fs/node` and `./mermaid`. Dependencies: `js-sha256`, `pathe`.
- `packages/dagworkflows`: the package `@mrmeku/dagworkflows`, the CI runner. Its exports are `.` and `./github`. `./github` exports exactly `createGithubHost(opts?: { token?, fetch? })`, the GitHub host adapter, and its two helpers `flattenGroups` and `openStopToken`. The action's resolve hook does not serve this subpath, only the bare `@mrmeku/dagworkflows`. It has the `bin` `dag` and `engines.node >=24.2`. Dependencies: `@actions/glob`, `@commander-js/extra-typings`, `@mrmeku/dagraph`, `commander`, `proper-lockfile`, `shlex`, `std-env`, `string-width`, `supports-hyperlinks`. Optional peer dependencies: `@actions/artifact ^6.3.1`, `@actions/cache ^6.3.0`, `@actions/core ^3.0.1`, `@actions/github ^9.1.1`.

Both packages are `private: true` in the tree and point `exports` at `.ts` source. Packing is what turns them into publishable packages (below). Both are MIT licensed. The CI and the release pin Node 24 and Bun 1.4.2. No minimum Bun version is declared anywhere: the root `package.json` has no `engines.bun` and no `packageManager`, and there is no `bunfig.toml` or `.bun-version`. The only declared engine is Node `>=24.2`, in `@mrmeku/dagworkflows`.

In practice a clone needs **Bun 1.4.0 or later**, and only for the engine's tests. Under Bun 1.3.14 and earlier, `bun test ./packages/dagraph` fails 8 of its 78 tests, so `bun run ci` fails `test:dagraph` and with it `require-all`. Two differences of those Bun versions cause it:

- **A call to `declare` is dropped.** Bun transpiles a statement that calls a function named `declare` as a TypeScript `declare` statement, and removes it. Two test helpers make such a call, each to a parameter named `declare`: `refusal` in `graph.test.ts` and `keyOfUse` in `dag.test.ts`. Renaming those parameters makes 7 of the 8 tests pass.
- **`JSON.stringify` skips a non-enumerable own `toJSON`** on a plain object. That is how `notAString` makes a node ref refuse JSON (see [dagraph-graphs](dagraph-graphs.md)), so a node ref and a settled ref stringify as `{"name":"download"}` instead of throwing. The eighth test, "a ref, a node's ref and a file input refuse every conversion to a string", fails on this alone.

This was found by running a copy of the repository on 2026-10-26:

- Bun 1.3.1, 1.3.2 and 1.3.10 to 1.3.14 drop the `declare` call; 1.4.0 and 1.4.4 make it. 1.3.1 and 1.3.14 skip the `toJSON`; 1.4.0 calls it, as Node does. Versions before 1.3.1 were not tried.
- Under 1.3.1 and 1.3.14, `bun install --frozen-lockfile` (the lockfile stays unchanged), `build:action`, `lint` and `typecheck` pass. Only those 8 tests fail.
- Under 1.4.0, `bun run ci` passes all 8 nodes.

Root scripts (run with `bun run <name>`):

| Script         | Command                                                        | Purpose                                                                 |
| -------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `ci`           | `node packages/dagworkflows/src/cli.ts run scripts/ci.ts`      | The CI graph, locally. Needs Node 24.2 or later.                        |
| `release`      | `node packages/dagworkflows/src/cli.ts run scripts/release.ts` | The release graph, locally. Off a release tag this is always a dry run. |
| `build:action` | `cd packages/dagworkflows && bun run build:action`             | Bundle the action into `packages/dagworkflows/action/dist/`.            |
| `typecheck`    | `tsgo --noEmit`                                                | Typecheck with the native TypeScript preview.                           |
| `lint`         | `bun --bun eslint .`                                           | Lint.                                                                   |
| `format`       | `prettier --write .`                                           | Format (with `prettier-plugin-organize-imports`).                       |
| `docs`         | `node scripts/docs.ts`                                         | Regenerate the generated docs (below).                                  |

Tests are split by runtime:

- The engine runs under Bun: `bun test ./packages/dagraph`. The leading `./` matters, because a bare path is a substring filter for `bun test`.
- The runner and the scripts run under Node's test runner: `node --test "packages/dagworkflows/src/**/*.test.ts" "scripts/*.test.ts"`. The package's own `test` script is `node --test "src/**/*.test.ts"`.

`.gitignore` ignores `node_modules`, `dist`, `*.tgz` and `.dag/`. `.gitattributes` marks `bun.lock` and `packages/*/docs/api/**` as generated.

### CI (`.github/workflows/ci.yml`)

The workflow runs on push to `main` only, and on every pull request whatever its base branch (`pull_request` has no branch filter), with permissions `contents: read` and `checks: write`. Its steps are checkout, Node 24, Bun 1.4.2, `bun install --frozen-lockfile`, `bun run build:action`, and then the action from source with `workflow: scripts/ci.ts` and `GITHUB_TOKEN`.

`scripts/ci.ts` is the graph. It runs at most 4 nodes in parallel (`maxParallelism: 4`), and at most 2 at a time in the concurrency group `test` (`concurrencyLimits: { test: 2 }`). That group has two members, `test:dagraph` and `test:dagworkflows`, so both tests can run at once. They come from the shared checks module `scripts/checks.ts`, as do `typecheck`, `lint` and the pack checks, so they are the same in `scripts/ci.ts` and `scripts/release.ts`. The pack, typecheck, lint and (in the release) docs nodes have no group. Its nodes:

- `restore:cas`: an `actions/cache` restore of `.dag/cas` with key `dag-main-<sha>` and restore key `dag-main-`.
- `typecheck` (`bun run typecheck`) and `lint` (`bun run lint`). Both have as inputs every package source, `scripts/**`, `eslint.config.ts`, `package.json`, `bun.lock` and `tsconfig.json`.
- `test:dagraph`: inputs are only the engine's sources and the toolchain files, so a runner-only change does not re-run it.
- `test:dagworkflows`: inputs are the engine, the runner and the scripts.
- `pack:dagraph` and `pack:dagworkflows`: each packs its package as a release would, at the unused version `0.0.0-ci`, so a change that breaks packing fails CI. Output: `mrmeku-<pkg>-0.0.0-ci.tgz`.
- `require-all`: requires all six checks above.
- `save:cas`: added only when the ref is `refs/heads/main`. It waits for every other node.

Every check depends on `restore:cas`. Pull requests read main's cache entry and never write or evict it. No check reads the root `README.md`. The pack checks do read `packages/*/README.md`, because the tarball ships it.

### Packing (`scripts/pack.ts`)

Usage: `bun scripts/pack.ts <package> <version> <out dir>`. With fewer arguments it fails with `usage: pack.ts <package> <version> <out dir>`. It must run from the dag repository root, because it reads `packages/<pkg>`. A relative `<out dir>` resolves from the current directory, and it must already exist: with a missing one, `npm pack --pack-destination` fails with ENOENT and the script throws `npm pack ... exited <n>`. It never edits the tree:

1. It compiles every package with `bunx tsgo -p tsconfig.build.json` into a temporary staging directory: JavaScript and declarations, with relative `.ts` imports rewritten to `.js`, and tests excluded.
2. It writes a staged `package.json`:
   - `version` set to the version given.
   - `private` and `scripts` removed.
   - Every `.ts` path turned into `.js`.
   - Every `workspace:` entry of `dependencies` pinned to the same version, so `@mrmeku/dagworkflows@1.2.3` depends on `@mrmeku/dagraph` `1.2.3`. Only `dependencies` are pinned. `devDependencies`, `peerDependencies` and `peerDependenciesMeta` ship as they are in the tree.
3. It runs `npm pack`, which writes `<out dir>/mrmeku-<pkg>-<version>.tgz` and prints its name.

Per package:

- **dagraph** ships `files: ["src", "README.md"]`, with `.js` and `.d.ts` side by side.
- **dagworkflows** ships `files: ["src/**/*.js", "types", "README.md"]`. Its declarations are bundled with rollup and `rollup-plugin-dts` into one file per export: `types/index.d.ts` and `types/github.d.ts`. The types of its optional peers and dev-only packages (`@actions/artifact`, `@actions/cache`, `@actions/github`, `proper-lockfile` via `@types/proper-lockfile`, `retry` via `@types/retry`) are inlined. A consumer's typecheck therefore never needs a package they may not have installed. Each export becomes `{ "types": "./types/<name>.d.ts", "default": "./src/<path>.js" }`, and `types` is `./types/index.d.ts`. If the bundled declarations import anything outside the package's dependencies, packing fails with `dagworkflows's declarations import <names>`.

Packing copies `packages/<pkg>/README.md` into the tarball, so that file must exist.

**The description on npm comes from the README.** Neither package's `package.json` has a `description`, and packing adds none (it would ship one: it keeps every field it does not rewrite). So `npm publish` fills it from the README it ships. npm 11 (`@npmcli/package-json`, in the `prepare` it runs before a publish) skips the leading blank lines and lines starting with `#`, and takes the lines from there to the next blank line, joined by spaces. A README that opens `# dagworkflows`, a blank line and a sentence gets that sentence. One that opens `<div align="center">` and a blank line gets `<div align="center">`, which is the registry's description of `@mrmeku/dagraph` today. This was checked on 2026-10-26 with `npm view @mrmeku/dagraph description`, and with npm 11.11's `PackageJson.prepare` on two scratch packages. The code holds no tagline for either package. Its one-line descriptions of the runner are the CLI's top-level help and the `description` of `action.yml` (both quoted above), and they share the opening "Run a CI workflow as a dagraph DAG". See Open questions.

Its other failures:

- `packages/<pkg>/package.json: <field> is not a record of strings`, for `dependencies` (or, for dagworkflows, `exports`) holding anything but strings by name;
- `<package> is not installed`, when a package whose types are inlined, such as `@types/retry`, cannot be found in `node_modules`;
- `<command> exited <n>` or `<command> was killed by <signal>`, when `tsgo` or `npm pack` fails.

### Release (`.github/workflows/release.yml` and `scripts/release.ts`)

The release workflow runs on a pushed `v*` tag, with permissions `contents: read`, `id-token: write` (npm trusted publishing through OIDC) and `checks: write`. Its steps are checkout, Node 24 with `registry-url: https://registry.npmjs.org`, Bun 1.4.2, install, `build:action`, and then the action with `workflow: scripts/release.ts` and the environment `GITHUB_TOKEN` and `ACTION_DEPLOY_KEY`. The deploy key is read from the environment, never from a node's command or config, so it is never hashed into a cache key.

**Version.** The ref must match `refs/tags/v<MAJOR>.<MINOR>.<PATCH>[-<prerelease>]` (pattern `^refs/tags/v(\d+\.\d+\.\d+(?:-[\w.]+)?)$`). Then the version is that number, and the run is a real release. Any other ref is a **dry run** of version `0.0.0-dev.<first 7 chars of sha>`, or `0.0.0-dev.local` when there is no sha. That includes a branch, a local run, and a tag like `vnext`.

**The graph.** At most 4 nodes run in parallel, and at most 2 in group `test`, the same settings and group members as CI.

- `restore:cas`: key `dag-release-<version>-<sha>`, restore keys `dag-release-<version>-` and then `dag-main-`. A re-run of a release therefore finds its own earlier attempt first, and a fresh release finds main's CAS.
- `docs`: `node scripts/docs.ts --check`. Fails while any generated doc is stale.
- `typecheck`, `lint`, `test:dagraph`, `test:dagworkflows`: the same nodes as CI. A tree that CI already tested is a cache hit.
- `require-all`: over those four and `docs`.
- `pack:dagraph`, `pack:dagworkflows`: `bun scripts/pack.ts <pkg> <version> <outputDir>`. The output `tarball` is `mrmeku-<pkg>-<version>.tgz`.
- `build:action`: bundles `main.js` and `post.js` as declared outputs.
- `upload:dagraph`, `upload:dagworkflows`, `upload:action`: artifacts named `dagraph-<version>`, `dagworkflows-<version>` and `action-<version>`. They upload as soon as their inputs are built, whether or not `require-all` passes, so you can inspect what a dry run or a failed publish would have shipped.
- `publish:dagraph`, `publish:dagworkflows`: a shell line, `npm view @mrmeku/<pkg>@<version> version || npm publish "$TARBALL" --access public`, plus ` --tag next` for any version containing `-`, plus ` --dry-run` on a dry run.
  - `$TARBALL` is the pack's output.
  - They depend on `require-all` and their pack. `publish:dagworkflows` also depends on `publish:dagraph`, so the engine is published before the runner that depends on it.
  - They are cached (`cacheable: true`), keyed by the tarball and the command, so a re-run skips a publish that already succeeded. Because `npm view` succeeds for a version npm already has, a run without its cache never publishes twice either.
  - A dry run's command differs, so its cache entry never stands in for a real publish.
  - Prereleases go under the `next` dist-tag (npm 11 insists on one), so `latest` only ever moves to a release. Trusted publishing also attaches provenance.
- `release:action`: `bun scripts/release-action.ts <version> <main.js> <post.js> [--dry-run]`, after `require-all` and `build:action`, cached likewise.
- `release`: requires `publish:dagraph`, `publish:dagworkflows` and `release:action`.
- `save:cas`: on a real release only, after every other node. After a failure it saves under a partial key, `<key>-partial-<run id>`, which the next attempt's restore finds as a prefix. That partial-key rule belongs to [dagworkflows-cache-artifacts](dagworkflows-cache-artifacts.md). A dry run saves nothing.

Locally, `bun run release` is a dry run: real tarballs and the action bundle land in the CAS, and nothing is published. The publish nodes still call `npm view` and `npm publish --dry-run`.

**`scripts/release-action.ts`.** Usage: `bun scripts/release-action.ts <version> <main> <post> [--dry-run]`. With missing arguments it fails with `usage: release-action.ts <version> <main> <post> [--dry-run]`.

1. It clones `git@github.com:mrmeku/dagworkflows.git`. On a dry run it clones a new scratch bare repository instead.
2. It checks out `main`, or an orphan `main` if there is none, and empties it.
3. It copies `packages/dagworkflows/action/action.yml`, `packages/dagworkflows/action/README.md`, `LICENSE`, and the two bundles as `dist/main.js` and `dist/post.js`.
4. It commits `dagworkflows v<version>` as `dagworkflows release <dagworkflows@users.noreply.github.com>`. Empty commits are allowed.
5. It force-moves the tags `v<version>` and `v<major>`, and prints `git show --stat` of the commit.
6. It pushes `main` (not forced) and force-pushes both tags.
7. It prints `pushed: main, v1.2.3, v1`, or on a dry run `dry run: pushed to a scratch repository: main, v1.2.3, v1`.

When `ACTION_DEPLOY_KEY` is set, the key is written to a temporary file (mode 600) and used through `GIT_SSH_COMMAND` with `IdentitiesOnly=yes` and `StrictHostKeyChecking=accept-new`.

### The docs and their staleness check (`scripts/docs.ts`)

Part of the docs is generated from code, and `bun run docs` (`node scripts/docs.ts`) rewrites it.

1. **The API reference.** TypeDoc writes it with `typedoc-plugin-markdown`, from the TSDoc of each entry of each package's `exports` map, into `packages/<pkg>/docs/api/`.
   - Configuration is in `typedoc.json`: no readme, `router: module`, sources disabled, output dir cleaned, formatted with Prettier.
   - Validation warnings are errors, except "not exported". A failing TypeDoc stops the script with `typedoc exited <status> for <pkg>`.
   - It does not depend on the action being built, and `bun run build:action` need not come first. TypeDoc reads its program from `tsconfig.json`, which has `allowJs` on and leaves out `packages/dagworkflows/action/dist` (beside `node_modules`). The comment there gives the reason: in the program, the bundle would reorder unions in the API reference. So the reference is the same with and without `dist/`, and `--check` gives the same answer either way. The release workflow orders nothing between the two: `docs` and `build:action` both wait only for the CAS restore. Checked on 2026-10-26: `node scripts/docs.ts --check` exits 0 without `dist/` and again after `bun run build:action`; with `dist/` built but taken out of that `exclude`, it reports `packages/dagworkflows/docs` as stale (`api/index/README.md` differs).
2. **Generated sections** of two READMEs: `cli` and `files` in `packages/dagworkflows/README.md`, and `action` in `packages/dagworkflows/action/README.md`. Each section sits between `<!-- generated:<name> -->` and `<!-- /generated:<name> -->`. There are three:
   - `cli`: usage lines of the form `npx --no dag <command> <workflow> [options]`, a table of commands, and a table of options with the commands that take each, its default, its meaning, its choices and its environment variable. All of it comes from the commander program in `cli.ts`.
   - `action`: the inputs table from `action.yml`, with default, meaning and "Required.". An input without a string `description`, or with a non-boolean `required` or a non-string `default`, fails with `<path of action.yml>: inputs are not action inputs`.
   - `files`: the table of paths from `config.ts`: CAS, CAS logs, `last-run.json`, history, logs, failures report and summary.

   A section with no generator fails with `<path>: no generator for section "<name>"`. A missing section fails with `<path>: no section for <names>`. The page is formatted with the repository's Prettier config.

   Both READMEs ship as they are in the tree. Packing copies the package README into the tarball, which npm shows, and `release-action.ts` copies the action README into `mrmeku/dagworkflows`. So the npm page carries the CLI and file tables of the version it ships, and the action repository carries its inputs.

`node scripts/docs.ts --check` copies each package's `docs/` and the two READMEs to a temporary directory, regenerates the copy, and compares each with `diff -rq`. If any differs, it prints `<paths>: stale, run \`bun run docs\``with each stale path, and exits 1. Only the release runs the check (the`docs` node). CI does not, because docs are written when a release is cut, not in every change.

**The demo media.** `packages/dagworkflows/docs/media/` holds a demo animation, `demo.gif`, with the files it is recorded from: `demo.tape` (a recording script; the `.tape` format is VHS's), `demo-workflow.ts` and `fake-tool.sh`. Nothing in `scripts/` or any `package.json` script regenerates it, and `docs --check` does not compare it, so it is re-recorded by hand. `demo.gif` (about 14 s) shows two `npx --no dag run scripts/ci.ts` runs in the `live` style. The workflow is `demo-workflow.ts`, with seven nodes: `install`, `build`, `typecheck`, `lint`, `test:unit`, `test:e2e` and `require-all`, run by `fake-tool.sh` standing in for npm, tsc, eslint and vitest. In both runs `lint` fails with an eslint `no-console` error, and `require-all` fails because of it. The first run's recap reads `built 5 · cached 0 · failed 2`. In the second, `typecheck`, `test:unit` and `test:e2e` are cached and the recap reads `built 2 · cached 3 · failed 2`. The banner in the GIF reads `ref=main`, while today's runner prints `ref=refs/heads/main`, so the recording predates the change to the local ref and is stale.

Where it lives: `package.json`, `packages/*/package.json`, `.github/workflows/{ci,release,pull-requests}.yml`, `CONTRIBUTING.md`, `scripts/{ci,checks,release,release-action,pack,docs,process-each}.ts`, `scripts/{ci,release}.test.ts`, `typedoc.json`, `tsconfig.build.json`.

---

## Rules that always hold

- One workflow file runs the same locally and on GitHub. Only the host (output), the cache store and the artifact store differ.
- Off GitHub the CLI never loads the optional peers `@actions/github`, `@actions/cache` or `@actions/artifact`. Only `@actions/glob` and the `@actions/core` it brings load, when the workflow globs or hashes.
- A run never starts a task while an earlier run of the same workflow still owes a post step that failed again.
- A run that ends normally deletes its history unless it owes a post step. A run that is killed or force-exited leaves its history, owed or not, until the next `run` or `post` of that workflow over the same history directory pays or drops it. On a GitHub-hosted runner none comes: the history goes with the VM.
- The action's bundle carries none of the local terminal code.
- Nothing secret is part of a node's command or config. The deploy key and the tokens come from the environment.
- Published action refs: `main` and `v<major>` move with each release. `v<version>` names one version, but a re-run of that version's release (without a cache hit) moves it too. npm's `latest` moves only to versions without a prerelease part.

## Open questions

1. **`--only` on `dag post` and the action's post entry is ignored.** Both parse it, but the post pass always takes the selection from each history. Is the option meant to filter which owed post steps run, or should `post` drop it?
2. **Prereleases move the major tag.** For a prerelease such as `1.3.0-rc.1`, `release-action.ts` still force-moves `v1` to it, while npm keeps such versions off `latest`. Consumers on `@v1` would get a prerelease. Is that intended?
3. **The post entry can miss a killed main.** If GitHub kills the main entry outright, its history lock stays fresh for up to 10 s. A post entry that starts within that window treats the run as alive and skips it, prints nothing and exits 0. The post steps then wait for a next run that finds the history, which on a GitHub-hosted runner never comes (see [dagworkflows-lifecycle](dagworkflows-lifecycle.md), "When a debt outlives the job"). The code does not say whether this window is accepted.
4. **Unknown `--only` names crash.** An unknown name, a bad workflow file, or a missing workflow file reaches the user as an uncaught Node stack trace rather than a one-line error. The exit code is 1 either way.
5. **`v<version>` is not immutable.** `release-action.ts` force-pushes `v<version>` on every run, so a re-run of a release that misses its cache re-points a tag consumers may have pinned. Is that accepted, or should the push refuse to move an existing `v<version>`?
6. **The action's comment on `force`.** `src/action/env.ts` says "`force` is the main entry's alone", yet both entries parse it, so an invalid value also fails the post entry and leaves the owed post steps unpaid. Should the post entry skip reading `force`?
7. **`@mrmeku/dagworkflows` is not on npm.** On 2026-10-25 `npm view @mrmeku/dagworkflows` answers 404 (as the registry still did on 2026-10-26), though `@mrmeku/dagraph` is published (`0.1.0`, `0.1.1`, `0.2.0`, `0.3.0`, and a `0.0.0-stage`) and the action repository `mrmeku/dagworkflows` has the tags `v0`, `v0.1.1`, `v0.2.0` and `v0.3.0` (`v0` and `v0.3.0` on its `main`), with no `v1`. Every one of those refs is a build of the earlier `dagactions` action (`name: dagactions`, inputs `workflow`, `cas`, `journal`, `force`, `only`, a bundle that serves only `@mrmeku/dagactions`), so no ref of `mrmeku/dagworkflows` runs the current action, and a dagworkflows workflow file under `@v0` fails. The action is usable only once a dagworkflows release moves a ref, the CLI only from tarballs, and whether consumers then write `@v0` or `@v1` depends on the tag the owner pushes. Why the runner's publish never landed is not settled by the code.
8. **Where are the release notes?** `CONTRIBUTING.md` says a fix arrives "with credit in the release notes", but nothing writes release notes, and no source says where they would live.
   - The release pushes a commit `dagworkflows v<version>` and lightweight tags to `mrmeku/dagworkflows` through a deploy key, which gives git access only, not GitHub's API.
   - The export pushes `Export <sha>` commits and lightweight tags to `mrmeku/dag`. The release workflow there has `contents: read`, too little to create a GitHub release.
   - The tree has no changelog.
   - On 2026-10-26 the GitHub API lists no releases for `mrmeku/dag` or `mrmeku/dagworkflows`, and every tag of both is lightweight, so no tag message holds notes either.

   - The export squashes each change into one commit authored `export`, with no `Co-authored-by` trailer, so the public history does not name a contributor either.

   Should the release write notes (a GitHub release on `mrmeku/dag` would need `contents: write`), should the export keep a contributor's name (as a trailer on its commit), or should `CONTRIBUTING.md` stop promising credit? Until one is chosen, a page cannot say where a contributor is credited.

9. **The Bun floor is undeclared.** A clone works from Bun 1.4.0 (see "Layout and tools"), but nothing states it: no `engines.bun`, no `packageManager`, and CI pins 1.4.2. The floor was found only by running the tests, on two Bun differences they happen to meet, so a new test can raise it without any check noticing. Should the repository declare it, in `engines.bun` or `packageManager`, and should CI pin it rather than 1.4.2?
10. **Which major is the first dagworkflows release?** The code leaves it to the pushed tag (see "Where it is published, and how consumers reference it"). A 1.x release makes the consumer job's `@v1` work and leaves `v0` on the `dagactions` build. A 0.x release, at a version `@mrmeku/dagraph` has not published such as `0.4.0`, moves `v0` to the current action, and a consumer job would then pin `@v0`; jobs already on `@v0` (the `dagactions` build, with its inputs `cas` and `journal`) would get the new action, whose inputs are `cas-dir` and `history-dir`, at their next run. Nothing records which the owner intends: no `package.json` has a `version`, no script or workflow names a next version, and on 2026-10-26 the tags are unchanged (`v0.1.1`, `v0.2.0` and `v0.3.0` on `mrmeku/dag`; `v0`, `v0.1.1`, `v0.2.0` and `v0.3.0` on `mrmeku/dagworkflows`, all `dagactions` builds). Every example in these documents writes `@v1` meanwhile, and so does every page written from them: the consumer job in the package README and in the action README, and the major tag the action README tells a reader to pin. If the first release is a 0.x, all of them change to `@v0`. Checked again on 2026-10-26: `git ls-remote` of both repositories shows the same refs, and `npm view @mrmeku/dagworkflows` still answers 404. Until the owner decides, a page for people can name no ref that works today, and no SHA either, since no ref runs the current action.
11. **No tagline in code.** Neither package has a `description`, so npm shows each README's first paragraph that is not a heading, and a centred HTML header shows on npm as `<div align="center">` (see "Packing"). The runner's two one-line descriptions, in the CLI help and in `action.yml`, agree only on "Run a CI workflow as a dagraph DAG". Should each `package.json` carry a `description`, so that npm and the READMEs can state one tagline? Nor does anything tie the opening sentence of `packages/dagworkflows/action/README.md` to the tagline of `packages/dagworkflows/README.md`. `release-action.ts` copies the action README as it is, and no script or check reads the opening of either, so whether the two agree word for word is settled by the pages alone, not by the code.
12. **Are issues on `mrmeku/dagworkflows` read?** Issues are enabled there, while pull requests stay open with no reply and cannot be merged (see "Where it is published, and how consumers reference it"). The code does not say whether anyone watches that repository's issues, or whether a report filed there is moved to `mrmeku/dag`. Should issues there be turned off, or answered with a pointer to `mrmeku/dag`, as pull requests on `mrmeku/dag` are?
