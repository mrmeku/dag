# dagworkflows: the life of a run

## The problem

A CI workflow often sets something up that has to be taken down again: a database container, a
cloud environment from `terraform apply`, a lock on a shared resource. If the teardown runs only
when everything goes well, a failed test, a Ctrl-C or a killed process leaves the container
running, and the next run fails because the port is taken, or someone gets a cloud bill.

GitHub Actions solves this for its own steps with an action's `post:` script: once the `main:`
part has run, the `post:` part runs at the end of the job, whatever happened. dagworkflows runs a
workflow as a DAG (a graph of nodes, run in parallel as their dependencies allow) and gives every
task the same promise, in a stronger form: the promise survives a cancel, a crash and even a
`kill -9`, because it is written to disk before the task does anything.

This domain covers what happens to one run from start to end: how teardowns are owed and paid, how
a run is cancelled and timed out, what it writes down about itself, how it reports what happens
as it happens (the run store), and what it returns.

## Terms

- **Task**: a node a workflow adds with `workflow.task`. Its work is an `action` (a TypeScript
  function), a `cmd` (an argv run with no shell) or a `shell` (a string run under bash). See the [dagworkflows-workflows](dagworkflows-workflows.md) domain.
- **Main**: a task that has a post step. The name comes from GitHub's `main:`/`post:` pair.
- **Post step** (or just **post**): the release a task gives in its `post` field. It is a node of
  its own, with its own name.
- **Owed**: a post is owed once its main has _started_, and stays owed until it _succeeds_.
  Think of it as a debt: starting the main borrows, a successful post pays back.
- **Pass**: one execution over a set of nodes, drawn as one block of output with its own banner,
  recap and step summary. A run is one pass. A **post pass** is a pass that runs only owed posts.
- **Run history** (or **history**): a JSON file a run writes as it goes, recording which nodes
  started and how each settled. It is how a later process knows what an earlier one owes.
- **Settled**: a node has a final result: `done`, `cached`, `failed`, `dep-failed` (skipped
  because a required dependency did not succeed) or `cancelled`.
- **Run store**: the in-memory record of a run that every output (terminal, GitHub log, check
  runs, files) reads from. Outputs subscribe to it as **listeners**.
- **CAS**: the content-addressed cache directory where nodes' outputs live (`.dag/cas` by
  default). See the [dagraph-caching](dagraph-caching.md) domain.

## A run, start to end

`runWorkflow` (and `dag run`, which wraps it) goes through these phases, in order:

1. **Build the graph.** It asks the host for the CI context (ref, sha, …), then calls the
   workflow's implementation, which adds nodes. Then it picks the nodes to run: all of them, or
   the closure of `--only` names plus the posts of every main in that closure (the [dagworkflows-workflows](dagworkflows-workflows.md) domain owns selection).
2. **Pay old debts.** Before anything of its own, it looks in the history directory for runs of
   the _same workflow file_ that are no longer running and still owe posts, and runs those posts,
   each history as a post pass of its own. If any of them fails again, the run stops here: **no
   task of this run starts**, an error is annotated, and the run fails. The reasoning: whatever
   that post releases may still be there, and starting again on top of it is how you get the
   "port already in use" failure.
3. **Begin its own pass**: the banner is drawn, and the run creates its own history file and
   locks it. The banner's title is `<workflow file> · ref=<ref> · <scope> · force`, leaving out
   the parts that are absent (no file, an empty ref, no `--force`). `<scope>` is `<total> nodes`,
   or `<selected> of <total> nodes (--only <names>)` with `--only`, for example
   `ci.ts · 3 of 4 nodes (--only slow)`. The banner's lines name every selected node, posts
   included.
4. **Execute** the graph. Each node's start is written to the history _before_ its action runs;
   each result is written when the node settles.
5. **Clean up the history**: if the run owes nothing (every post whose main started has
   succeeded), its history file is deleted. Otherwise it stays for a later pass.
6. **Finish the pass**: the summary is rendered and published, the recap printed, and the outcome
   returned.

A run leaves a history behind only if, when it ends, it owes a post: one whose main started and
that has not succeeded. That is a run with a post that failed every try, or a cancelled run in
which some main had started before the cancel. A cancelled run whose graph has no posts, or none of
whose mains started, deletes its history like a green run.

## Post steps as obligations

### Declaring a post

A task gives its release in `post`:

```ts
const db = workflow.task({
  name: "up:db",
  shell: 'docker run -d postgres > "$ID"',
  env: ({ out }) => ({ ID: out.id }),
  outputs: { id: "id" },
  post: {
    name: "down:db",
    shell: 'if [ -n "${ID:-}" ]; then docker rm -f "$(cat "$ID")"; fi',
    env: ({ main }) => ({ ID: main.id }),
  },
});
workflow.task({ name: "test", cmd: ["bun", "test"], deps: { db } });
```

What a post takes (type `PostSpec`):

- `name` (required): its node name, unique in the graph. It is what logs, check runs, the history
  and `--only` call it.
- Exactly one of `action`, `cmd` or `shell`, as for a task. With `cmd` or `shell` it may also take
  `cwd` and `env`.
- `timeoutMs` (optional): as for any task, see Timeouts. It covers all the post's tries together.
- `retry` (optional): `"backoff"`, the default, or `"once"`.

What a post does **not** take, enforced by the types:

- No `deps`. Whatever the release needs, its main depends on, so whenever the post is owed it can
  run.
- No `inputs`, `cacheable`, `outputs` or `concurrencyGroup`.
- A task that has a `post` may not set `inputs` or `cacheable`: such a task is never cached,
  because a cache hit starts nothing and would leave nothing to release.

The post reads its main's outputs under the role `main`:

- In `env` (for `cmd`/`shell`), `env: ({ main }) => ({ ID: main.id })`. A main that did not succeed
  (it failed, timed out or was cancelled) gives its post none of its outputs, so every variable
  read from `main` is **unset**, even for a file the main wrote before it failed. The script must
  test it:
  `if [ -n "${ID:-}" ]; then …; fi`.
- In an `action`, as `depOutputs.main`, which is `undefined` when the main did not succeed.

A post is never cached: it runs every time it is owed. A `cmd`/`shell` post has the action kind
`post`; an `action` post has its own name as its kind, so two action posts get separate keys and
logs.

### When a post is owed

The rule is simple and exact: **a post is owed exactly when its main started, whatever the main
then did, and stays owed until the post succeeds.**

"Started" means the engine was about to run the main's action: the start is recorded in the
run's history, and the engine waits for that write to finish before the command runs. So even if
the process is killed one microsecond after the command started, the history already says the
post is owed.

Cases, all pinned by tests:

| What happened to the main                                                          | Is the post owed?                                                                                                                |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Succeeded                                                                          | Yes (and it runs at the end of the run)                                                                                          |
| Failed after starting                                                              | Yes; it runs, with the main's missing outputs unset                                                                              |
| Cancelled while its command ran                                                    | Yes; it is paid by the post pass                                                                                                 |
| Skipped because a dependency failed (`dep-failed`)                                 | No: it never started, so the post is skipped too (`dep-failed`)                                                                  |
| Cancelled while waiting for a concurrency-group slot                               | No: it never started                                                                                                             |
| Cancelled before its command started (e.g. while its output directory was made)    | No                                                                                                                               |
| Cancelled in the instant between its start being recorded and its command starting | Yes, though nothing ran: the record says it started. This is why a release must be safe to run when there is nothing to release. |

A post's work must be safe to do twice and safe to do when nothing was set up (`docker rm -f`,
`compose down`), because a retry, a crash at the wrong moment or the case just above can run it
again or for nothing.

### Where a post runs in the graph

Within a run, a post runs after its main, **and after every node of the run that is downstream of
its main** (anything that depends on the main, directly or through other nodes), whatever those
nodes did. In the example, `down:db` waits for `up:db` and `test`, and runs even if `test` fails.

Posts of different mains run in the reverse order of their mains, as GitHub runs post scripts:

- A post also waits for the posts of mains downstream of its own. If `test` depends on `up:db` and
  both have posts, `test`'s post (`dump`) runs before `down:db`: a test's post may still use the
  database.
- It does not wait for other posts of its _own_ main.

Example from the tests: tasks `cas` (post `save`), `up:db` (post `down:db`, depends on `cas`),
`test` (depends on both). The commands run in this order: `cas restore`, `db start`, `test`,
`db stop`, `cas save`.

A post requires what its main requires: when one of the main's required dependencies did not
succeed, the main never starts, so the post is `dep-failed` too.

Nothing depends on a post, so posts come last. A cache save (`workflow.cache(...).save()`, see the [dagworkflows-cache-artifacts](dagworkflows-cache-artifacts.md) domain) waits for every other task of the run but never for a post.

With `--only`, the selection includes the post of every main it reaches. `--only test` on the
example runs `up:db`, `test`, `down:db`; `--only up:db` starts the database and stops it at once.

### Retries and failure

By default (`retry: "backoff"`) a failed try runs again after 1000 ms, and again after 4000 ms
more: three tries in all. The delays are fixed in `config.ts`; nothing configures them. Each failed try but the last
adds a line to the post's log:

```
Try 1 of 3 failed: its shell command exited 1. Trying again in 1000 ms.
```

`retry: "once"` gives one try, for a slow release that a retry never helps, such as
`terraform destroy`.

Retrying stops early when the post's signal fires (a cancel, or its `timeoutMs`), including
during the wait between tries.

When every try failed, the post is `failed`, the run fails (exit code 1), the post **stays owed**,
and the run's history stays on disk. The next run of the workflow that finds that history pays it
before any task. On a GitHub-hosted runner none finds it (see "When a debt outlives the job").

A post's failure is always counted as its own failure, never as a consequence of something
upstream, even though it ran after failed nodes. So it is named in the recap's `failed:` line and
in the `reproduce:` line.

### Paying a post

A post is paid (run until it succeeds) in one of these places:

1. **In its own run**, at the end, in the normal course of things.
2. **In the post pass after a cancel.** A cancelled run does not run posts in its main pass: once
   the cancel comes, every node that becomes ready, posts included, settles `cancelled`. Then a
   post pass runs the owed posts: in the same process with `dag run` (via `runJob`), or in the
   action's `post:` entry on GitHub. The post pass does not watch the cancel signal. Under
   `dag run` it runs to the end, and only a second signal stops it (see Signals). The action's
   `post:` entry installs no signal handler, so a single signal that reaches it ends the process
   at once; the history's lock is removed on exit, and the history stays owed for the next pass.
3. **In the action's `post:` entry** on GitHub, which runs at the end of the job whatever became
   of `main`. It pays whatever the main entry's run still owes: posts a cancel or kill kept from
   running, and posts that failed every try (they get three more tries).
4. **At the start of the next run of the same workflow** (`dag run` or the action's `main`),
   for any run that stopped without paying: a run killed outright, or one whose post failed. The
   run must find that history, which on a GitHub-hosted runner it does not (see "When a debt
   outlives the job").
5. **With `dag post <workflow>`**, which runs only the owed posts and nothing else.

A post pass rebuilds the graph the old run ran (the workflow file's graph, with the old run's
`--only`), and feeds the post the main's result as the old history recorded it: a main whose
result was recorded gives its outputs; a main the kill caught mid-action has no result and is
treated as `cancelled`, so its outputs are unset. In a post pass the post needs only its main:
a dependency the workflow file has added to the main since the old run cannot hold the payment
back.

If the workflow file no longer declares the post at all, the old history is not owing anything
and is deleted silently.

Each old history is paid in its own post pass, with its own banner and summary section. All
owed histories are tried even if one fails. If any failed, the new run then refuses to start:

```
[error] dag: No task ran: post steps that an earlier run owes failed again (1), and what they release may still be there. Fix them and run again, or, once it is gone, remove that run's history in .dag/history.
```

The escape hatch is in the message: once you have removed by hand whatever the post releases,
delete that history file.

### When a debt outlives the job

"The next run pays it" holds only for a run that finds the history: a run of the same workflow
file (same resolved path) over the same history directory. Nothing in dagworkflows carries a
history from one machine or job to the next. It is not under the CAS directory, so a cache of
`.dag/cas` leaves it behind. And a run pays its debts before any node of its graph runs, so a
cache restore in the graph comes too late to bring one back for that run.

On GitHub the action keeps its histories in the workspace (`.dag/history` unless the
`history-dir` input says otherwise), so a post step that the action's post entry cannot pay is
paid later only if the runner keeps that directory for the next job. The post entry fails to pay
it in one of two ways:

- **The post fails again.** Its three more tries fail. The post entry draws the post pass (the
  banner `post · <owed> of <total> post steps owed`, the post's group, its error annotation, and
  the recap `✖︎ <post> failed · <workflow file> · post`) and exits 1, so the post step fails and
  the job is red. The history stays in the workspace, under the pass's new name.
- **The post entry skips a killed main** whose lock is not yet stale (see "The lock"). It prints
  nothing and exits 0. The main step has already failed.

On a GitHub-hosted runner, GitHub provisions a new VM when the job begins and decommissions it when
the job has finished (GitHub's docs, "Using GitHub-hosted runners"), and the history goes with it.
The next run starts with no history: it owes nothing and starts its tasks, and its post entry has
nothing to pay. So the debt is never paid: nothing retries the release, and nothing holds a later
run back. Something the post was to release on the runner itself, such as a container or a
background process, goes with the VM. Something outside it, such as a cloud environment or a lock
on a shared resource, stays, and only the failed job's log shows it. An ephemeral self-hosted
runner, which takes one job, is the same.

A persistent self-hosted runner keeps its workspace between jobs, but `actions/checkout` by
default runs `git clean -ffdx && git reset --hard HEAD` before it fetches (its `clean` input,
default `true`). That deletes every ignored file, `.dag/` with it. So with the default
`history-dir`, the next job's checkout deletes the history before the action starts, as a fresh
runner would. With `history-dir` set to an absolute path outside the checkout, or with
`clean: false`, the next run of that workflow on that runner finds the history. It then pays it
before any task, or refuses to start while the post still fails. The history records the main's
outputs as paths into the CAS (relative to the working directory when `cas-dir` is), and the clean
deletes the CAS too unless `cas-dir` is also outside the checkout. Then the post runs with
`main.<output>` naming a file that is gone: a post that does `cat "$ID"` prints
`cat: …/id: No such file or directory`, may still exit 0, and so clears the debt without releasing
anything.

This was checked with the CLI in GitHub mode standing in for the action's two entries, with a post
that fails every try:

1. `dag run` exited 1, and `dag post` exited 1 with the recap `✖︎ down failed · ci.ts · post`.
2. `git clean -ffdx` then deleted `.dag/`, and the next `dag run` started every task.
3. With `--history-dir` outside the checkout, the history survived the clean. The next `dag run`
   drew `post · 1 of 1 post steps owed`, annotated `No task ran: …`, and exited 1.

And with the local CLI, in a git checkout ignoring `.dag/`, with a post
`echo "stopping $(cat "$ID")"; [ ! -e fail-down ]` given `ID: main.id`:

4. With only `--history-dir ../kept`, after `git clean -ffdx` and `rm fail-down`, `dag post` drew
   `✔︎ down:db`, logged the `cat` error and a bare `stopping`, exited 0 and deleted the history.
5. With `--cas-dir ../kept-cas` as well, the history recorded the output as
   `../kept-cas/<key>/out-<hash>/id`, and the same `dag post` logged `stopping db-20686`.

**What is left to a GitHub user** when a post fails in both entries on a GitHub-hosted or
ephemeral runner: nothing in dagworkflows. There is no history file to remove, since it went with
the runner; no later run owes the post, and a re-run of the job, on a new VM like any job, starts
its tasks; `dag post` anywhere else finds nothing. The post entry adds no advice of its own: the
`No task ran: …` line belongs to a run that pays old debts, and the post entry's pass only fails.
What the post released on the runner went with it. Whatever it releases outside the runner must be
released by hand, and the failed job's log is the only record of what that is: the post entry's
step holds the post's group, with its log, each failed try and its error annotation; the main
step holds the group of the post's main. The main's outputs, which the post read under `main`,
were files in the runner's CAS and are gone with it, so only what the main or the post printed
says which thing to release. To have a later run pay such a debt instead, run the job on a
persistent self-hosted runner with `history-dir` and `cas-dir` outside the checkout, as above;
there the debt is paid, or its history found and removed, as with a local run.

### Post pass output

A post pass draws like a run: a banner group, a start line and a group per node, a recap, and a
step summary section.

- Banner title: `post · <owed> of <total> post steps owed`, with the owed post names as its
  lines. `<total>` counts every post in the old run's graph.
- Recap and summary title: `<workflow file> · post` (or `run · post` when no file was named).
- The summary draws only the owed posts, without their edges to the rest of the graph.
- A post pass that owes nothing prints nothing at all (no banner, no summary, no recap). This is
  the common case for the action's `post:` entry.

### Worked example (real CLI output)

Run in a temporary directory, with `--output-style grouped` so the output is plain lines. The
workflow file `ci.ts`:

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
    workflow.task({ name: "test", shell: "sleep ${SLEEP:-0}; [ ! -e fail-test ]", deps: { db } });
  },
});
```

**A green run** (`dag run ci.ts`): exit 0, and `.dag/history` is empty afterwards.

```
▶ ci.ts · 3 nodes
    up:db
    test
    down:db
▷ up:db
▶ ✔︎ up:db (9ms)
    started db
▷ test
▶ ✔︎ test (9ms)
▷ down:db
▶ ✔︎ down:db (8ms)
    stopping db-4176
summary: .dag/summary.md

✔︎ all 3 nodes succeeded · ci.ts · built 3 · cached 0 · failed 0 · skipped 0 · wall 26ms
```

**A release that fails** (`touch fail-down`, then `dag run ci.ts`): three tries over about five
seconds, exit 1, and one history file is left in `.dag/history`.

```
▷ down:db (last run 8ms)
▶ ✖︎ down:db (5.0s)
    stopping db-4250
    Try 1 of 3 failed: its shell command exited 1. Trying again in 1000 ms.
    stopping db-4250
    Try 2 of 3 failed: its shell command exited 1. Trying again in 4000 ms.
    stopping db-4250
    ── error ──
    its shell command exited 1
[error] down:db: its shell command exited 1
summary: .dag/summary.md

✖︎ down:db failed · ci.ts · built 2 · cached 0 · failed 1 · skipped 0 · wall 5.1s
failed: down:db
reproduce: npx --no dag run ci.ts --only down:db
```

**The next run, while it still fails**: only the owed post runs (it stops the _old_ database,
`db-4250`), then the run refuses to start. Exit 1.

```
▶ post · 1 of 1 post steps owed
    down:db
▷ down:db (last run 5.0s)
▶ ✖︎ down:db (5.0s)
    …three tries as above…
✖︎ down:db failed · ci.ts · post · built 0 · cached 0 · failed 1 · skipped 0 · wall 5.0s
failed: down:db
[error] dag: No task ran: post steps that an earlier run owes failed again (1), and what they release may still be there. Fix them and run again, or, once it is gone, remove that run's history in .dag/history.
```

**Paying with `dag post`** (`rm fail-down`, then `dag post ci.ts`): exit 0, history gone. A
second `dag post ci.ts` prints nothing and exits 0.

```
▶ post · 1 of 1 post steps owed
    down:db
▷ down:db
▶ ✔︎ down:db (9ms)
    stopping db-4250
summary: .dag/summary.md

✔︎ 1 node succeeded · ci.ts · post · built 1 · cached 0 · failed 0 · skipped 0 · wall 9ms
```

**A Ctrl-C during `test`** (`SLEEP=5 ./node_modules/.bin/dag run ci.ts`, SIGINT after two
seconds): the run is cancelled, then the same process runs the post pass. Exit 130. This output
needs dag started directly: under `npx` or `npm exec` in a terminal, one Ctrl-C delivers SIGINT to
dag twice (the terminal signals the whole process group, and npm forwards SIGINT and SIGTERM to
its child), so the first Ctrl-C already takes the second-signal path: exit 130 at once, no post
pass, and the history left owed without a lock.

```
▷ test (last run 8ms)
SIGINT: cancelling, waiting for running commands to stop
▶ ◼︎ test (cancelled)
    killed by SIGINT
◼︎ down:db: cancelled
summary: .dag/summary.md

◼︎ cancelled, 2 nodes not run · ci.ts · built 1 · cached 0 · failed 0 · skipped 0 · cancelled 2 · wall 1.9s
cancelled: test, down:db
▶ post · 1 of 1 post steps owed
    down:db
▷ down:db (last run 9ms)
▶ ✔︎ down:db (9ms)
    stopping db-4646
summary: .dag/summary.md

✔︎ 1 node succeeded · ci.ts · post · built 1 · cached 0 · failed 0 · skipped 0 · wall 9ms
```

**A `kill -9` during `test`** (of the dag process itself, the `node …/node_modules/.bin/dag run
ci.ts` child, for example with `pkill -9 -f 'bin/dag run ci.ts'`; killing an `npm exec` parent
leaves the run going): nothing is printed for the post, and the history and its lock stay
in `.dag/history`. Its history records `started: ["up:db", "test"]` and only `up:db`'s result. A
`dag post ci.ts` within about ten seconds prints nothing (the lock still looks held, so the run
looks alive); after the lock goes stale it pays `down:db`, which stops the database the killed run
started. Only a process killed outright leaves its lock behind like this; see "Signals in the CLI
and the action". Note that the killed run's own command (`sleep`) keeps running: nothing kills the
command's process group when dag itself is killed outright.

Where it lives: `packages/dagworkflows/src/post.ts`, `select.ts`, `runner.ts`, `task.ts`
(retries), `config.ts`, `action/post.ts` and `action/env.ts` (the post entry, `history-dir`); tests `release.test.ts`, `post.test.ts`,
`runner.test.ts`.

## Services a task sets up

A "service" here is anything a task starts that outlives its command: a database container, a
server started in the background. dagworkflows has no notion of keeping a service up _between_
runs: every run starts its services afresh and releases them through posts. The only thing that
crosses from one run to the next is a debt, and a run pays its predecessors' debts before it
starts anything (so the old service is gone before the new one starts).

Within a run, a service is shared by every node downstream of the task that started it, and is
released only once all of them have settled (see "Where a post runs").

A command that leaves a background process holding its output open (a server started with `&`) is
cut off 1000 ms after the command exits, so it does not keep the node running (`createExec`'s
`streamDrainGraceMs` changes the delay). That process itself keeps running; releasing it is the post's job.
When a command exits on its own, nothing signals what it left behind in its process group; only a
cancel or a timeout does (SIGTERM to what is left of the group, see "How a command is
interrupted"), and a second signal SIGKILLs every group.

### Keeping a service up across runs

There is no option for this, but the rules above give a pattern. Debts are per workflow file: a
run pays only the histories of its own workflow file (matched by resolved path), and leaves every
other workflow's alone. So a service meant to outlive many test runs lives in workflow files of
its own, and its start has no `post`:

- `up.ts`: a task that starts the service in the background, with no `post` and no inputs (a
  cached start would start nothing). Redirect its output (`>/dev/null 2>&1`), or the node waits
  the 1000 ms stream drain.
- `ci.ts`: the tests, which find the service already up. Each run of it starts and releases
  nothing of the service's.
- `down.ts`: a task that stops it, safe to run when nothing is up.

Verified in a scratch repository: `up.ts` runs `nohup sleep 30 >/dev/null 2>&1 & echo $! > svc.pid`;
the process is alive after `dag run up.ts`; two runs of `ci.ts` (`kill -0 "$(cat svc.pid)"`) both
succeed; `dag run down.ts` (`kill "$(cat svc.pid)"`) stops it.

What you give up: nothing owes the stop. A crash, a Ctrl-C or a forgotten `down.ts` leaves the
service running, and no later run releases it. A task with a `post` cannot be used for this: its
post runs at the end of the very run that started it, once everything downstream has settled.

A separate meaning of "services", owned by `services.ts`: the GitHub toolkit's **cache and
artifact services**, which the CLI picks when it runs on GitHub:

- On GitHub (`GITHUB_ACTIONS=true`), `dag run` and `dag post` (which pick the stores the same way
  and print the same notices) use `@actions/cache` as the cache store only when
  `ACTIONS_CACHE_URL` or `ACTIONS_RESULTS_URL` is set and the toolkit says the feature is
  available; otherwise it annotates a notice and runs with no cache store:
  `actions/cache is off: this step cannot reach the cache service; use the action instead of `dag run``.
- Likewise for artifacts: `actions/upload-artifact is off: this step cannot reach the artifact service; use the action instead of `dag run``.
Off GitHub there is no artifact store and no notice, and the cache store is the local worktree
store, never `@actions/cache`.
- The toolkit packages are optional peer dependencies, loaded only when a service is there. If one
  is needed and missing, the error is: `dag needs @actions/cache on GitHub, an optional peer
dependency it does not install: add it (npm install --save-dev @actions/cache), or use the
action, which bundles it, instead of `dag run``.
- The action (which bundles the toolkit) prints its own notices once, from its main entry:
  `actions/cache is off: no cache service in this environment` and
  `actions/upload-artifact is off: no artifact service in this environment`.

The cache and artifact stores themselves belong to the [dagworkflows-cache-artifacts](dagworkflows-cache-artifacts.md) domain.

Where it lives: `services.ts`, `action/env.ts`, `ports/real.ts` (stream drain).

## Run history

### The file

Each run writes its own history file at `<history dir>/<random UUID>.json`. The history directory
is `.dag/history` by default (`DEFAULT_HISTORY_DIR`), set with `--history-dir` on the CLI and the
`history-dir` input of the action. Runs at the same time never share a file.

Its content (type `RunHistoryFile`):

```json
{
  "workflow": "/private/tmp/dwl/ci.ts",
  "started": ["up:db", "test", "down:db"],
  "results": {
    "up:db": {
      "name": "up:db",
      "actionKey": "fde7…",
      "status": "done",
      "outputs": { "id": ".dag/cas/fde7…/out-c949…/id" },
      "contentHash": "c949…",
      "elapsed": 8
    },
    "test": { "name": "test", "actionKey": "…", "status": "done", "…": "…" },
    "down:db": {
      "name": "down:db",
      "actionKey": "bc14…",
      "status": "failed",
      "error": {
        "name": "Error",
        "message": "its shell command exited 1",
        "cause": {
          "argv": ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", "…"],
          "cwd": ".",
          "code": 1
        }
      },
      "elapsed": 5045
    }
  }
}
```

- `workflow`: the workflow file, resolved to an absolute path, so `ci.ts` and `./ci.ts` are the
  same workflow. It is `""` when the caller named no file (a library caller of `runWorkflow`).
  So every run that names no `workflowFile` counts as the same workflow: two different
  implementations that share a history directory without a `workflowFile` pay each other's
  histories, each over its own graph.
- `only`: the run's `--only` names, present only when it had some.
- `started`: the nodes whose action started, in the order they started.
- `results`: each settled node's whole result, as the engine produced it (type `RunHistory`, a
  record from node name to dagraph `Result`).

The file is written as the run goes: once before any node (empty `started` and `results`), at
every start (awaited before the action runs), and at every result. Each write goes to
`<path>.<UUID>.tmp` and is renamed over the file, so a kill mid-write leaves the last whole
version. Writes are serialized.

### The lock: is that run still going?

While a run is going it holds a lock beside its history, `<path>.lock`, using `proper-lockfile`.
The lock is a directory, so it works across processes, containers and hosts that share the history
directory. The run refreshes it while it runs and releases it when it is done with the history.
A lock not refreshed for 10 seconds is stale: its run was killed outright. A process that ends
any other way (a normal exit, a thrown error, a second signal, a default-handled Ctrl-C) has its
lock removed by `proper-lockfile` as it exits, so the next pass can pay it at once.

A pass that pays debts skips any history whose lock is held and not stale: that run is still
going (perhaps on another host), and its posts are its own business. Consequences:

- Two runs at once never touch each other's posts. A run started while another runs leaves that
  run's history alone; the post pass pays it once that run has stopped.
- After a `kill -9` (or an out-of-memory kill), the next run pays the killed run's posts only once the lock has gone stale,
  up to about ten seconds later. A run started sooner runs normally and leaves the old history
  for a later pass.
- If a run loses its own lock (another process took it as stale), Node prints a process warning
  `the lock on <path> was lost: <reason>` and the run goes on. At worst a later pass pays its
  posts while it is still running.

### How a pass treats the histories it finds

For every `.json` file in the history directory:

1. A file whose lock is live is skipped.
2. A leftover half-written temporary file (anything after `.json` other than `.lock`) is deleted.
3. The file is read and checked. A history of **another workflow** file is left alone for that
   workflow's next run.
4. A history that cannot be read (bad JSON, wrong shape, or an `--only` naming a node the
   workflow no longer has) is deleted, with its lock, and annotated as a warning (title `dag`):
   `ignoring the run's history <path>: <reason>. The post steps it owed do not run.` The reasons
   from the shape check are `it records no started nodes, as a history from before dag recorded
them` and `not a run's history: it lacks its workflow, started nodes or results`.
5. A history that owes nothing is deleted.
6. Otherwise the pass **claims** it by renaming it to a fresh history of its own (new UUID, new
   lock). If two passes race, the second rename fails and that pass skips it. The owed posts run,
   and their results are written into the claimed history. If nothing is owed afterwards, it is
   deleted; if a post failed again, it stays (under its new name) for the next pass.

Exported: `createRunHistory(fs, lockfile, dir, initial)` creates and locks a history (it returns
an object with `path`, `results`, `started`, `begin`, `onEvent`, `flush` and `close`);
`readRunHistory(fs, path)` reads and checks one; `runHistoryLive(lockfile, path)` says whether its
run still holds the lock. These are what the runner uses; most callers never need them.

Where it lives: `history.ts`, `runner.ts` (settling), `config.ts`.

### Finding the history that holds a debt

No command lists the histories or what they owe, and no output names a history file: a post
pass's banner and recap name the post steps and the workflow file, and the `No task ran: …` line
names only the directory. When the directory holds several histories, the files themselves say
which one holds a failing debt:

- `workflow` is the workflow file resolved against the process's working directory, which is a
  physical path: a run started from a directory reached through a symlink records the real path.
  Compare it with `$(pwd -P)/ci.ts`, not `$PWD/ci.ts`.
- A post that failed every try has a result with `"status": "failed"` and its `error`, whose
  `cause.argv` is the command it ran. A post a cancel kept from running has
  `"status": "cancelled"`, and one a kill kept from running has no result, while its main is in
  `started`. `results` also holds the run's failed tasks: the file does not mark which nodes are
  posts, so look a post up by the name the output gave it.
- Each pass that tries the debt adds the post to `started` again, so a history whose post failed
  in its run and again in one pass reads `"started": ["up:db", "test", "down:db", "down:db"]`.
- The main's result holds its `outputs`, the CAS paths of the files the post is given under
  `main`, such as the id of what it releases. They tell two histories that owe the same post
  apart, as the post's own log does when it prints what it releases.
- A history with a `<file>.lock` directory beside it whose lock is fresh belongs to a run still
  going, and no pass touches it.
- The file name is no identity: a pass that claims a history and fails again leaves it under a
  new UUID, so a name listed before a `dag run` or `dag post` is gone after it.

The file is written with two-space indentation, so `grep -l '"workflow": "<path>"'` finds a
workflow's histories. With `jq`, one line per history, with its file, its workflow file and the
nodes it records as failed:

```sh
jq -r '[input_filename, .workflow, ([.results[] | select(.status == "failed") | .name] | join(","))] | @tsv' .dag/history/*.json
```

and the histories in which one post of one workflow file failed:

```sh
jq -r --arg workflow "$(pwd -P)/ci.ts" --arg post down:db \
  'select(.workflow == $workflow and .results[$post].status == "failed") | input_filename' \
  .dag/history/*.json
```

This was checked with the CLI in a scratch directory. A failed `down:env` of `deploy.ts` and two
concurrent runs of `ci.ts`, whose `down:db` then failed, left three histories; the run in the
other process was live, so neither run paid the other's. With `down:db` changed to fail only for
one database id, the next `dag run ci.ts` drew two post passes, one per history, each with its own
banner and no path: one failed (`stopping db-18471`), one paid (`stopping db-18454`). It then
refused with `failed again (1)`. The failing history had moved from `20f5e2f5-….json` to
`5a1ddbcb-….json`. The first command printed it as `ci.ts`'s with `down:db`, and `deploy.ts`'s
with `down:env`; the second printed only `5a1ddbcb-….json`.

## Cancellation and signals

### What a cancel does

A run is cancelled through the `signal` option (an `AbortSignal`). When it fires:

- Nodes waiting to become ready, and misses waiting for a concurrency-group slot, settle
  `cancelled` without running. Posts and cache saves are among them: a cancelled run never runs
  them in its main pass.
- Running commands are interrupted (see below). A node whose action was running when the cancel
  came settles `cancelled`, whatever its command exited with: once the signal fired, the exit
  status no longer decides. A cancel wins over the node's own timeout. A cancelled result is never
  cached.
- The run store goes to the `cancelling` state. Its recap lists `cancelled: …`, and its counts
  line adds `cancelled <n>`. The headline is `◼︎ cancelled, <n> nodes not run` only when nothing
  failed or was skipped before the cancel; otherwise it names the failures
  (`✖︎ <names> failed`) or the skips (`⏭︎ <n> nodes skipped, a dependency failed`).
- The run's outcome has `cancelled: true` and exit code 130.
- A cache save the cancel lands on settles `cancelled` (the store may already have taken the
  entry), and nothing owes it: the post pass never runs a save.

Then the owed posts are paid by a post pass (see "Paying a post").

A cancel can also come while the run is still paying old debts (phase 2). Those posts do not watch
the signal, so they run to the end. If they are paid, the run's own pass starts with the signal
already fired: every node settles `cancelled` without starting, and the exit code is 130. If they
fail again, the run refuses to start as usual, and its outcome has `cancelled: false` and exit
code 1, although the signal fired.

### How a command is interrupted

The real `Exec` (`createExec`) runs each command in a process group of its own and sends signals
to the whole group, so whatever the command started stops with it. On a cancel or a timeout, the
way GitHub's runner interrupts a step:

1. SIGINT to the group;
2. SIGTERM 2000 ms later;
3. SIGKILL 1000 ms after that.

Once the interrupted command itself exits, whatever is left of its group (for example a
background job that ignores SIGINT) gets SIGTERM, and SIGKILL if still there 1000 ms later. The
command settles only when its group is gone.

A command killed by a signal resolves with code -1, and `killed by <SIGNAL>` is appended to its
stderr and output (this is the `killed by SIGINT` line in the cancelled node's log). A command
asked to run after the signal already fired does not start, and resolves with code -1 and
`cancelled before start`. `createExec({ sigintGraceMs, sigtermGraceMs, streamDrainGraceMs })` is the only
way to change these delays and the stream drain's.

### Signals in the CLI and the action

`abortOnSignals()` returns an `AbortSignal` that fires on SIGINT, SIGTERM or SIGHUP: Ctrl-C or a
closed terminal locally, and on GitHub the runner's SIGINT to the step (followed by its SIGTERM
7500 ms later).

- **First signal**: prints `<SIGNAL>: cancelling, waiting for running commands to stop` (for
  example `SIGINT: cancelling, waiting for running commands to stop`) and cancels the run. From
  then on, a write to a terminal or pipe that is gone (EPIPE, EIO) is ignored, so the cancel and
  the post pass go on without their output after a SIGHUP.
- **Second signal**: SIGKILLs the process group of every command still running and exits at
  once with code 130. The posts the run owes are left for the next run (or `dag post`); the
  history's lock is removed as the process exits, so that run can pay them at once. The
  grace delays above (3 s in all) are chosen so that the first SIGINT's cancel normally finishes
  before GitHub's SIGTERM, which would count as the second signal.

`dag run` uses `abortOnSignals()` and `runJob`; the action's main entry uses `abortOnSignals()`
and `runWorkflow`; `dag post` and the action's post entry take no signal.

So a Ctrl-C during `dag post` gets Node's default handling: dag ends at once. The history's lock is
removed on exit, so the history stays owed for the next pass. The release command that was running
keeps running: it is in a session of its own, which the terminal's SIGINT does not reach, and
nothing interrupts or kills its process group.

A process killed outright (`kill -9`) runs no handler: its history stays with a lock that goes
stale, and its commands' process groups keep running.

Where it lives: `ports/real.ts`, `runner.ts`, `cli.ts`, `action/main.ts`, `config.ts`; the
cancel rules of the engine in dagraph's `process-node.ts` and `orchestrate.ts` ([dagraph-execution](dagraph-execution.md) domain).

## Timeouts

Any task, and any post, may set `timeoutMs`, a whole number of milliseconds from 1 to 2147483647. Another value throws when the graph is built:
`action "<kind>": timeoutMs must be a whole number of ms from 1 to 2147483647, got <value>`,
where `<kind>` is `run`, `run-shell` or `post` for a command, and the name for an `action`.

When the time is up, the node's signal fires and its command is interrupted exactly as for a
cancel (SIGINT, SIGTERM, SIGKILL). Then:

- The node is `failed`, **whatever its command exited with**, even 0 (a command that traps SIGINT
  and exits cleanly still timed out).
- In the run store (`FailedNodeState.error`, with `timedOut: true`) and in every output that
  reads it, the error reads as GitHub's runner words it:
  `The action '<name>' has timed out after <time>.` where `<time>` is in minutes from one minute
  up (`1 minute`, `1.67 minutes`), otherwise as a short duration (`30ms`, `1.5s`). Example:
  `The action 'test' has timed out after 30ms.`
- The dagraph `Result`, in `RunOutcome.results` and in the history file, keeps the engine's
  words: `error.name` is `"TimeoutError"`, `error.message` is `timed out after <ms> ms`, plus the
  `cause` carried by what the action threw as it stopped, if any.
- On GitHub its check run concludes `timed_out`; an error annotation carries the message; the
  node's log group ends with `── error ──` and the message, after what the command printed.
- A timed-out result is never cached. `timeoutMs` is not part of the node's cache key: changing
  it does not rebuild anything.
- For a post, the timeout covers all its tries and the waits between them, and ends the retries.

Where it lives: dagraph `process-node.ts` (the signal), `kernel/run-slice.ts` (the message),
`github/renderer.ts` (the check conclusion); test `runner.test.ts` ("timeoutMs").

## Exit codes and the outcome

`runWorkflow` and `runPost` resolve to a `RunOutcome` (`runJob` resolves to a number, the
`exitCode` of its `runWorkflow` outcome):

- `results`: the nodes' results (dagraph `Result`s) of the pass.
- `failed`: how many of those did not succeed. Note that this counts `failed`, `dep-failed` _and_
  `cancelled` results.
- `markdown`: the step summary the pass rendered.
- `cancelled`: whether the run's signal had fired by the end of the run.
- `exitCode`: `130` if cancelled; else `1` if `failed > 0`; else `0`.

What a user sees as the process exit code:

| Situation                                                                                                                            | Exit code                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Every node succeeded (post pass: every owed post paid, or nothing owed)                                                              | 0                                                                                         |
| A node failed, was skipped, or a post failed every try                                                                               | 1                                                                                         |
| The run refused to start because an old debt failed again                                                                            | 1                                                                                         |
| The run was cancelled by a signal (`dag run`, action main)                                                                           | 130, whatever the post pass after it did                                                  |
| A second signal                                                                                                                      | 130, at once                                                                              |
| An error thrown while building or running (for example `--only` naming an unknown node: `closure: the graph holds no node "<name>"`) | 1 (Node's exit for an unhandled error in the CLI; the action prints the error and sets 1) |
| Node older than 24.2                                                                                                                 | 1, with `dag needs Node 24.2 or later`                                                    |

Where it lives: `runner.ts`, `cli.ts`, `action/main.ts`, `action/post.ts`.

## The runner functions

All three take `RunOptions` (or most of it):

- `implementation` (required): the workflow's implementation, `defineWorkflow(...).implementation`,
  of type `Implementation`: `(graph, ports, ctx) => Promise<unknown>`, where `ctx` is the
  `CiContext` (so a workflow can branch on the ref or event).
- `ports` (required): the `Ports` (see below).
- `casBaseDir` (required): the CAS directory.
- `historyDir`: default `.dag/history`.
- `workflowFile`: the workflow file as given. It names the run in the banner, recap and summary
  heading (`run` when absent), identifies the workflow's histories, and builds the reproduce line.
- `only`: node names to run (with their closure and posts).
- `force`: ignore the cache for this run.
- `signal`: the cancel.
- `schedulerOptions`, `summary`: the workflow's concurrency limits and summary renderers.
- `rerunCommand`: the command the recap's `reproduce:` line starts with, used as given;
  `--only <names>` is appended to it. Default `npx --no dag run <file>`; with neither
  `rerunCommand` nor `workflowFile` the recap has no reproduce line. A post pass never prints
  one, even when a post fails in it.
- `store`: the run store to report to; default a store with the GitHub renderer on `ports.host`.

**`runWorkflow(options)`** runs the workflow once, as described in "A run, start to end", paying
old debts first. It resolves to the run's `RunOutcome`. When old debts were paid successfully,
the outcome holds only the run's own results and markdown; when they failed again, it holds the
debts' results and markdown, and no task ran.

**`runPost(options)`** (no `force` or `signal`) runs only the post steps that stopped runs of this
workflow still owe, as one post pass per history, and resolves to their combined outcome
(`cancelled` is always false). It does not run any task. With nothing owed, it draws nothing and
resolves with exit code 0; it still begins an empty pass titled `<workflow file> · post` on the
store and never finishes it, so a custom listener's `begin` hook hears it. This is `dag post` and the action's `post:` entry.

**`runJob(options, processEvents)`** is a whole job in one process, as `dag run` does it:
`runWorkflow`; then, if the run was cancelled, `runPost` with the same options. It resolves to the
run's exit code (from `runWorkflow`, not from the post pass) and rethrows any error.

When `options.store` is given (as the local `dag run` session gives one), both passes report to
that store, and `runJob` then calls its `close`, given the error if either threw. `processEvents`
is something with `once` and `off` for an `"exit"` event, normally `process`: if the process exits
before the close is done (a second Ctrl-C), the store is interrupted so that a terminal output can
restore the terminal. Without a `store`, `runWorkflow` and the `runPost` after a cancel each create
a separate default GitHub store, so the post pass is that store's first pass, and nothing is
closed, interrupted or moved to a final lifecycle. This is what `dag run` does on GitHub.

The action splits a job into two processes instead: its main entry calls `runWorkflow`, and its
post entry, which GitHub runs at the end of the job, calls `runPost`.

The CLI commands, as far as this domain goes (the [dagworkflows-cli-action-release](dagworkflows-cli-action-release.md) domain owns
the rest):

- `dag run <workflow> [--only <names>] [--force] [--cas-dir <dir>] [--history-dir <dir>]
[--summary-file <file>] [--output-style live|failures|grouped] [--log-dir <dir>]
[--failures-report-file <file>]`.
- `dag post <workflow> [--only <names>] [--cas-dir <dir>] [--history-dir <dir>]
[--summary-file <file>]`: "Run the post steps that stopped runs' histories show as still owed".
  Locally it always draws in the plain grouped form, with no live footer, log files or
  failures report.
- Defaults: `--cas-dir .dag/cas`, `--history-dir .dag/history`, `--summary-file .dag/summary.md`.

`postNodes(graph)` maps each post's name to its main's name; it is how the runner finds what a
history owes.

Where it lives: `runner.ts`, `steps.ts`, `cli.ts`.

## Node states and the run's lifecycle

### A node

Every node of a pass is in one of these states (types exported as `NodeState` and its members):

- `pending` (`PendingNodeState`): not yet running. The pass has begun and the node has not been
  dispatched, or it was dispatched, missed, and the scheduler holds it back (dagraph's `pending`
  event). Why it waits is the scheduler's own business, so the state does not say.
- `dispatched` or `running` (`InFlightNodeState`): handed to processing, then its action started.
  Both carry `startedAt`.
- Settled (`SettledNodeState`):
  - `done` or `cached` (`SucceededNodeState`): with `actionKey`, `outputs`, `startedAt`, `endedAt`.
  - `failed` (`FailedNodeState`): with `actionKey`, `startedAt`, `endedAt`, `error` (the message,
    a timeout in the runner's words), `timedOut`, and, when a command's failure caused it,
    `command` (a `CommandCause`, see below), plus the log once read.
  - `dep-failed` (`SkippedNodeState`): never dispatched; `endedAt` and `error`, which reads
    `dependency <name> failed`.
  - `cancelled` (`CancelledNodeState`): dispatched or not; `actionKey` is `""` for one cancelled
    before it had a key. It has `startedAt` if it was dispatched: the start time when its action
    was running, the dispatch time when it was cancelled before its action started. Only a node
    cancelled while still `pending` has none, so a present `startedAt` does not mean the action
    started.

Every state also carries the node itself (`node`, marked `post: true` for a post), the line its
command is printing now (`unfinishedLine`), the last line with text it ended (`lastLine`) and
whether it printed anything (`printed`). Settled states get `lineCount` once their log is read.

The usual paths: `pending → dispatched → running → done|failed|cancelled`, or
`pending → dispatched → pending → running → …` for a miss the scheduler holds back; a cache hit goes
`pending → dispatched → cached`; a skipped node goes `pending → dep-failed`; a node cancelled
before it ran goes from `pending` or `dispatched` to `cancelled`.

A node's duration is from its action's start to its settle, never counting the wait for its
concurrency group's slot. For a node that settled without starting, such as a cache hit, it is
from its dispatch. It is at least 1 ms.

A post pass begins its owed nodes afresh: they go back to `pending` in the store, replacing what
the run recorded for them.

### The run

The run's lifecycle (`RunLifecycle`, in `RunState.lifecycle`):

- `running`: from the start.
- `cancelling`: the cancel came (only from `running`).
- Final states, which never change once reached:
  - `finished`: closed normally;
  - `cancelled`: closed after a cancel;
  - `errored` (with `error`, a message): closed with an error thrown by the run;
  - `interrupted`: the process exited before the close (a second Ctrl-C).

`RunState` is `{ nodes, lastRunDurations?, lifecycle }`: `nodes` is a map from name to
`NodeState` over every pass so far; `lastRunDurations` the previous run's durations by node.

Changes come only as actions (type `RunAction`) through one pure reducer: the engine's events,
which keep dagraph's `ExecEvent` names rather than past-tense ones (`dispatch`, `pending`, `start`,
`output`, `result`, the non-output ones stamped with the
store's clock as `occurredAt`; with `logRead`, these are the node-level subset, type
`NodeAction`), and `logRead`, `passBegun`, `runCancelled`, `runClosed`,
`runErrored`, `runInterrupted`, `lastRunRead`, which the store adds. An event for a node no pass
began is ignored.

Where it lives: `kernel/run-slice.ts`, `kernel/selectors.ts`.

## The run store

### Why it exists

A run is drawn in several places at once: the terminal (live footer, or failures only, or
grouped), the GitHub log and check runs, the step summary, per-node log files, a failures report.
Each needs the same facts in the same order, and some need them at once (a check run must turn
`in_progress` the moment its node starts). The run store is one record of the run that all of them read, with
listeners told of each change.

### Creating one

`createRunStore({ fs, clock, casBaseDir, listeners, lastRunAtBegin? })` returns a `RunStore`:

- `fs`, `clock`: ports; the clock stamps events.
- `casBaseDir`: where it reads each settled node's log, `<casBaseDir>.logs/<actionKey>.log`, and
  reads and writes `<casBaseDir>/last-run.json`.
- `listeners`: an array of `RunListener`s, in order.
- `lastRunAtBegin`: read `last-run.json` when the store's first pass begins, so even the first
  start line can show the last run's time; later passes reuse that read. Without it the file is
  read once, just before the store first writes it (when the first node that built or failed
  settles), because a node may restore the CAS that holds it, or at the first `report` if no such
  node settled. So a pass of cache hits learns its `previous` durations only at the report. Only
  the local `dag run` session sets the option; `dag post` and the GitHub store do not, which is
  why `dag post`'s start line shows no last-run time.

What a store offers:

- `begin(pass)`: begin a pass (`Pass`: `title`, `nodes`, optional `banner` `{ title, lines }`,
  optional `rerunCommand`).
- `onEvent(event)`: feed it an engine event (dagraph `ExecEvent`).
- `cancel()`: mark the run cancelling. `runWorkflow` calls it when the signal fires.
- `report(pass)`: once every settle has been told and the last run is known, the pass's settled
  nodes as `NodeReport`s, in the pass's order (unsettled ones left out). It rewrites
  `last-run.json` if any node was timed.
- `log(name)`: a node's log as its group prints it: the log, then `── error ──` and the error for
  a failed node; just `dependency <name> failed` for a skipped one.
- `finish(pass, reports)`: tell the listeners the pass is over; resolves once they have all
  finished (a `finish` hook may be async).
- `close(error?)`: end the run (see Teardown).
- `interrupt()`: end the run at once (see Teardown).
- `getState()` and `dispatch(action)`: read the state, or dispatch an action directly.

### What a listener hears, and in what order

A `RunListener` may have any of these hooks:

- `begin(pass, run, isFirstPass)`: a pass began; `isFirstPass` is true for the store's first.
- `start(nodeState, run)`: a node's action started.
- `settle(nodeState, run, log)`: a node settled, with its log read from beside the CAS
  (`::debug::` lines dropped).
- `finish(pass, nodes)`: the pass ended, with its node reports.
- `close(run)`, `interrupt(run)`: teardown.
- `immediate.start(nodeState)`, `immediate.output(nodeState, lines)`: see below.

**The ordered hooks** (`begin`, `start`, `settle`, `finish`) come in the order things happened,
on one queue. A `settle` waits until its node's log has been read (and the last-run file written
when the node was timed), and everything after it waits for it. So no pass's `begin` ever comes
ahead of the previous pass's settles, even though the post pass may begin while the run's last
logs are still being read. The `run` argument is the state as it stands when the hook runs, which
may be later than the event.

**The immediate hooks** come at once, ahead of settles still queued: `immediate.start` the moment
a node's action starts, `immediate.output` each time a node's command ends one or more lines (the
lines as a terminal leaves them: after the last carriage return, escape codes and control
characters removed, `::debug::` lines dropped; blank lines kept). When a node settles with an
unfinished line, that line is announced as ended. They are for outputs that must not wait: the
GitHub check runs (`immediate.start`) and the per-node log files use them. The live terminal's
footer uses none; it redraws on a timer from `getState()`.

Verified with a two-node chain `build → test` and one listener:

```
begin ci.ts first=true
immediate.start build
start build
immediate.start test
settle build done ["hi"]
start test
settle test done ["hi"]
finish ci.ts build:done:1000,test:done:1000
close finished
```

`test` is heard to start immediately before `build`'s settle is told, because that settle was
waiting for its log; the ordered `start test` still comes after `settle build`.

**Errors.** An immediate hook that throws never breaks the engine or the command's output stream:
the error is put on the ordered queue, as if an ordered hook had thrown, and the other listeners
still hear the event. The ordered hooks queued after the throw do not run. The rejected queue has
no handler until `report`, `finish` or `close` awaits it, so in a real process the hook's error is
an unhandled rejection: under Node's default unhandled-rejections mode the process dies with it
(exit 1); Bun reports it, carries on, and exits 1. Only where unhandled rejections are not fatal
(or when `report` is already waiting on the queue) do `report` and `finish` reject, so that
`runWorkflow` rejects with the hook's error.

### Teardown

- `close(error?)` waits for everything queued (ignoring a rejection, since `error` is that
  run's own), moves the lifecycle to `finished`/`cancelled`, or `errored` when given an error,
  then calls every `close` hook **last listener first**, so the first listener (by convention the
  terminal) has the last word. Every hook is called even if one throws; the error thrown is that
  of the first hook called that threw, which is the one nearest the end of `listeners`.
- `interrupt()` is synchronous: lifecycle `interrupted`, then every `interrupt` hook last
  listener first, same error rule. It is meant for a process that is exiting now.
- A `close` after an `interrupt` still waits for the queued settles and calls every `close` hook,
  but the lifecycle stays `interrupted`: a final state never changes.

### The last run's durations

`<casBaseDir>/last-run.json` holds `{ "durations": { "<node>": <ms> } }`. As each node that
**built or failed** settles, its duration is merged over the previous file's and the file is
rewritten; cached and cancelled nodes do not change it. Because it sits in the CAS directory, a
cache of the CAS carries it from run to run. A file the store cannot read counts as no last run.
The durations show as `(last run 1.0s)` on start lines and as `previous` in node reports.

`NodeReport` (one per settled node): the pass's node fields plus `status`, `start` and `duration`
(absent for a node never dispatched), `previous`, `error` (failed or dep-failed), `outputs` (done
or cached).

### Reading the state

`selectors` (exported as a namespace) are pure functions over the state: `isSettled`,
`startedAtOf`, `actionKeyOf`, `durationOf`, `nodesInFlight` (dispatched or running, earliest
first), `runStartedAt`, `nodeReports`, `ownFailures`, `isOwnFailure`, `failedDepsOf`, `causesOf`,
`consequencesOf`.

The "own failure" rule (the terminal's and the failures report's): a failed node is its own
failure unless it failed only because a dependency did, which means it is `dep-failed`, or it
failed without a command of its own failing while a dependency had failed (as `requireAll` does).
A failed post is always its own failure. `causesOf` walks from a consequence back to the own
failures behind it; `consequencesOf` the other way, split into `failed` and `skipped`.

Where it lives: `kernel/store.ts`, `kernel/run-slice.ts`, `kernel/selectors.ts`,
`kernel/report.ts`; test `kernel/store.test.ts`.

## Ports, and running a workflow in a test

### The ports

Everything a run touches outside itself goes through `Ports`:

- `exec` (`Exec`): `run(argv, { cwd?, env?, signal?, onOutput? })` resolves to an `ExecResult`,
  `{ code, stdout, stderr, output, ok }` (`output` is both streams in arrival order), and never
  throws on a nonzero exit. No shell unless the argv starts one.
  `env` is merged over the inherited environment; an `undefined` value removes a variable. A
  program that cannot start resolves with code -1 and `spawn <program> <code>` (e.g.
  `spawn bash ENOENT`).
- `fs`: dagraph's `DagFs`.
- `clock` (`Clock`): `now()` and `sleep(ms, signal?)`, which ends early when the signal fires.
- `host` (`Host`): `context()`, `group`, `info`, `annotate`, `summary`, `check` (GitHub or local
  output; the [dagworkflows-output](dagworkflows-output.md) domain). `context()` resolves to the `CiContext`: `ref`, `sha`,
  `eventName`, `actor`, `runId`, `repo`, `serverUrl` (as the GitHub toolkit names them), plus
  `isCi` and `provider`.
- `cacheStore`, `artifactStore`: the [dagworkflows-cache-artifacts](dagworkflows-cache-artifacts.md) domain.
- `lockfile` (`Lockfile`): `proper-lockfile`'s `lock` and `check`, which the history uses.
- `env`: the process environment.

`WorkflowPorts` is `Ports` without `exec`: what a workflow and its tasks see, since a command runs
only through a node's shell, where its log, timeout and cancel apply.

Real implementations: `createExec(opts?)`, `systemClock()`, `abortOnSignals()`, and two hosts:

- `createLocalHost({ exec, fs, summaryPath, write? })`: terminal output through `write`
  (default `console.log`). The summary is written to `summaryPath` without escape codes, appended
  within a process so a post pass's summary follows the run's, and followed by a
  `summary: <path>` line. Its context comes from git: `ref` is `refs/heads/<branch>` (`""` on a
  detached HEAD), `sha` is HEAD's, `actor` is `git config user.name` or else `$USER`; `provider`
  and `eventName` are `local`, `isCi` is false, `runId` 0, and `repo` and `serverUrl` empty.
- `nullHost()`: does nothing; its context has provider `none` and empty fields.

### Step records

A node's log lives beside the CAS, never in it: `logPath(casBaseDir, actionKey)` is
`<casBaseDir>.logs/<actionKey>.log`, so a cached node shows the log of the run that built it. The
log is written whole when the node's action ends, to a file beside it that is then renamed into
place. So a store, or a concurrent run of the same key, never reads half a log, and a node that is
still running has no log there yet.

`CommandCause` (`{ argv, cwd, code }`, where `cwd` is `"."` when the command named none) is the
`cause` of a node's error when a command it ran failed, and the `command` of `FailedNodeState`.

`formatDuration(ms)` is the short duration the timeout message and the outputs use: `<ms>ms`
under 1000 ms, else seconds to one decimal (`1.5s`).

### Test doubles

`createTestPorts(opts?)` builds ports from doubles, the fixture every dagworkflows test starts
from. Options: `exec`, `clock`, `env`, `files` (initial in-memory files, path to text),
`cacheStore`, `artifactStore`, `context` (fields of the CI context). It returns:

- `ports`: with `exec` = `okExec` (every command succeeds silently) unless given, `clock` =
  `steppingClock()` unless given, an in-memory file system, a recording host, in-memory cache and
  artifact stores, an in-memory lockfile, and `env` = `{}`.
- `fs`: the in-memory file system (dagraph's `MemoryDagFs`; `fs.files` is a map you can inspect).
- `rec`: the `RecordedHost`.
- `cacheStore`, `artifactStore`: the in-memory stores.

Ports are plain objects: replace `ports.exec` (or `ports.fs`, `ports.host.group`, …) after
creating them to script a test.

- `createRecordingHost(context?)` returns a `RecordedHost`: `host`, plus `log` (in order: a group
  as `{ title, lines }`, a plain line as a string), `annotations` (`{ level, title, message }`),
  `summaries` (markdown strings) and `checks` (check-run updates). Its context has provider
  `recording` and empty fields unless overridden.
- `steppingClock(start = 0, step = 1000)`: each `now()` returns the next time, `start` first, then
  `step` ms later each call; sleeps end at once. This is why durations in tests are `1.0s`.
- `clockAt(now = () => 0)`: a clock that reads `now()` from the given function; sleeps end at
  once.
- `okExec`: an `Exec` whose every command exits 0 with no output.

The in-memory lockfile behaves like `proper-lockfile` (a second `lock` of a held path rejects with
code `ELOCKED`); at runtime it has a `held` set of lock paths, which a test can fill to make a
history look owned by a live run, but its type is not exported.

A worked test, verified with `node --test`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTestPorts, defineWorkflow, runPost, runWorkflow } from "@mrmeku/dagworkflows";

const ok = { code: 0, stdout: "", stderr: "", output: "", ok: true };

test("a cancel during the tests still stops the database", async () => {
  const { ports, rec } = createTestPorts();
  const controller = new AbortController();
  const calls: string[] = [];
  ports.exec = {
    run: async (argv) => {
      calls.push(argv.join(" "));
      if (argv[0] === "test") controller.abort();
      return ok;
    },
  };
  const ci = defineWorkflow({
    implementation: (workflow) => {
      const db = workflow.task({
        name: "up:db",
        cmd: ["compose", "up", "-d"],
        post: { name: "down:db", cmd: ["compose", "down"] },
      });
      workflow.task({ name: "test", cmd: ["test"], deps: { db } });
    },
  });
  const options = {
    implementation: ci.implementation,
    ports,
    casBaseDir: "/cas",
    historyDir: "/history",
  };
  const run = await runWorkflow({ ...options, signal: controller.signal });
  const post = await runPost(options);
  assert.deepEqual(
    {
      run: [run.exitCode, Object.fromEntries(run.results.map((r) => [r.name, r.status]))],
      post: [post.exitCode, post.results.map((r) => `${r.name} ${r.status}`)],
      calls,
      banners: rec.log
        .flatMap((e) => (typeof e === "string" ? [] : [e.title]))
        .filter((t) => !t.startsWith("✔") && !t.startsWith("◼")),
    },
    {
      run: [130, { "up:db": "done", test: "cancelled", "down:db": "cancelled" }],
      post: [0, ["down:db done"]],
      calls: ["compose up -d", "test", "compose down"],
      banners: ["3 nodes", "post · 1 of 1 post steps owed"],
    },
  );
});
```

Note in it: `test` is `cancelled` though its command returned exit 0, because the cancel fired
while it ran; the banner counts the post among the nodes (`3 nodes`); and the run's own post is
`cancelled` in the run and `done` in the post pass.

To test a run killed before its post pass, cancel the run and call `runWorkflow` again instead of
`runPost`: the next run pays the debt first (the in-memory lock was released when the first run
ended, so the history looks stopped).

Where it lives: `ports.ts`, `ports/real.ts`, `ports/local.ts`, `ports/memory.ts`,
`step-records.ts`, `kernel/format.ts`.

## Open questions

- `dag post` accepts `--only`, but `runPost` ignores it: each history is paid over its own run's
  `--only`. Is the option meant to filter, or should it not be offered?
- `runJob` returns the cancelled run's 130 whatever the post pass after it did; a post that fails
  in that pass shows only in the output and in the history left behind.
- When a run first pays old debts successfully, its `RunOutcome` leaves out the debts' results and
  markdown (they were drawn and published, but are not returned).
- If the `signal` is already aborted when `runWorkflow` is called, the store's `cancel` is never
  dispatched (the listener is added to an already-fired signal), so the lifecycle ends `finished`
  while the outcome says `cancelled: true`.
- `cancelled` (and so exit code 130) is whether the signal fired by the end of the run, even if it
  fired after every node had settled.
- On a GitHub-hosted runner the history directory lives in the workspace and goes with the
  runner, so a post that the action's post entry cannot pay (it fails again, or the entry skips a
  killed main whose lock is still fresh) is never paid by a later run (see "When a debt outlives
  the job"). The failed job is the only trace, and the user's one recourse is to release by hand
  what the post releases outside the runner. The code does not address it: is that accepted, or
  should such a debt reach the next job?
- A post pass hands the post its main's outputs as the history recorded their paths, without
  checking that the files are still there. When the CAS has gone and the history has not (a
  persistent runner's checkout cleaned with only `history-dir` outside it), the post runs on paths
  that are gone, and if it exits 0 the debt is cleared with nothing released. Should a pass refuse,
  or warn, when a main's recorded outputs are missing?
- A post's failure is always its own, so the recap's `reproduce:` line can name a post
  (`--only down:db`); per `select.ts`, that selection reruns the post's main as well as the post.
  Intended?
- If the workflow file drops a post that an old history owes, the history is deleted silently and
  the release never runs.
- After `kill -9` of dag, the commands it was running keep running (seen: an orphaned `sleep`);
  only a second signal kills their process groups.
- Whether a compose project name lets `down.ts` find a container service that `up.ts` started is
  not verified: only the pid-file pattern under "Keeping a service up across runs" was run (no
  Docker daemon was available to try it). What dagworkflows settles: both tasks run in the
  repository root unless given a `cwd`, with the process environment, and `down.ts` has no
  `main` to read. Docker's documentation (`https://docs.docker.com/compose/how-tos/project-name/`)
  takes the project name from `-p`, then `COMPOSE_PROJECT_NAME`, then the compose file's top-level
  `name:`, then the base name of the directory holding the compose file. So `docker compose up -d`
  in `up.ts` and `docker compose down` in `down.ts`, run from the same directory over the same
  compose file, would name one project, and the same `-p <name>` given to both would fix it
  whatever the directory. Should the semantics give it as a second pattern once it has been run?
- The focus asked for "services kept up between runs": the code has no such feature. Services
  are started per run and released by posts; `services.ts` is about the GitHub cache and artifact
  services. The separate-workflow pattern under "Keeping a service up across runs" works with
  the code as it is, but nothing owes its stop.
