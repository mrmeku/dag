# Run on GitHub

The job's YAML is in the README's [On GitHub](../README.md#on-github). This page covers what to add once that job runs: a CAS kept between runs, artifacts, a summary of your own, and secrets.

## Use the action

Run the workflow file with the action, not with `npx --no dag run` in a `run:` step. The runner hands only a JavaScript action the URL and token of GitHub's cache and artifact services. In a `run:` step every restore misses, every save does nothing and no artifact goes up.

The action also needs no install to start. It answers the import of `@mrmeku/dagworkflows` with its own bundle, so installing dependencies can be a task of the graph. To make the action's version match the one in your lockfile, pin the action as its README's [Versions](../action/README.md#versions) says.

## Keep the CAS between runs

A GitHub runner starts with an empty CAS, the content-addressed store of task outputs in `.dag/cas`, so every task builds again. `workflow.cache` adds a restore node and a save node that carry it over in GitHub's cache. This workflow caches the CAS, builds a report and uploads it:

```ts
import { defineWorkflow } from "@mrmeku/dagworkflows";

export default defineWorkflow({
  implementation: async (workflow) => {
    const cas = workflow.cache({
      name: "cas",
      path: [".dag/cas"],
      key: `ci-main-${workflow.ctx.sha}`,
      restoreKeys: ["ci-main-"],
    });
    const build = workflow.task({
      name: "build",
      shell: 'echo built > "$OUT"',
      env: ({ out }) => ({ OUT: out.report }),
      outputs: { report: "report.txt" },
      inputs: { version: "build-v1" },
      deps: { cas: cas.restore },
    });
    workflow.uploadArtifact({
      name: "upload:report",
      artifact: "report",
      deps: { build },
      path: ({ build }) => [build.report],
    });
    if (workflow.ctx.ref === "refs/heads/main") cas.save();
  },
});
```

On a new commit to `main`, the run goes like this:

1. `restore:cas` finds no `ci-main-<this sha>`. So it takes the newest entry starting with `ci-main-`: the CAS the last run on `main` saved.
2. `build` starts after the restore. Its inputs have not changed, so it is `cached`.
3. `upload:report` uploads `report.txt` from the CAS as the artifact `report`.
4. `save:cas` runs after every other node. If they all succeeded, it saves `.dag/cas` under `ci-main-<this sha>` for the next commit to find.

A pull request gets no save node, so it reads main's CAS and never writes one. The rules behind the pattern:

- **`path` matches the CAS directory.** The action's `cas-dir` input defaults to `.dag/cas`. Change one, change the other.
- **Tasks come after the restore.** A task is sure to find the restored CAS only if it depends on `cas.restore`, directly or through a task that does.
- **A key is written once.** GitHub's cache never overwrites an entry. The per-commit key above is new on every commit, and the shared prefix finds the newest. A cache with a fixed key, such as one for `node_modules`, keeps what it first saved. So put what decides its content in the key: `` key: `deps-${await workflow.hash("bun.lock")}` ``.
- **A red run saves a partial entry.** When a node did not succeed, the save stores `<key>-partial-<run id>` instead. The work that did succeed is kept, and the next restore finds it by prefix.

## Upload artifacts

`workflow.uploadArtifact` adds a node that uploads files as an artifact of the run, shown on its run page. `name` is the node's name and `artifact` the artifact's.

In the example above, `path` is a function of the dependencies' outputs, so `build.report` goes up straight from the CAS. `path` can also be a list of globs such as `["reports/**"]`, relative to the working directory. Globs never pick up the CAS under `.dag`, so to upload a task's output, use its handle.

## What GitHub shows

In the job log each node gets a log group, printed whole when it settles, so parallel nodes never interleave. A failed node's group holds its error, and the node gets an error annotation. After the groups comes the recap, here of a run that was cancelled after `lint` failed:

```
✖︎ lint failed · ci.ts · built 0 · cached 0 · failed 1 · skipped 0 · cancelled 2 · wall 4.0s
failed: lint
cancelled: slow, after
reproduce: npx --no dag run ci.ts --only lint
```

The recap names the root failures, the ones to fix first ([Read the recap](runs.md#read-the-recap)). `reproduce:` is the command that reruns them.

A task talks to GitHub through its log, as a `run:` step does: its `::warning`, `::error` and `::add-mask::` lines work.

With `GITHUB_TOKEN` in the step's `env` and `checks: write` on the job, each node also gets a check run in the pull request's Checks tab. A check run holds a status line and a link to the run's log. Without a token they are off.

### The step summary

At the end, the step summary goes on the run page. By default it is `DEFAULT_SUMMARY_RENDERERS`:

- `renderStatus`: the headline, counts, parallelism and cache hits.
- `renderTimeline`: a Gantt chart of what ran.
- `renderCriticalPath`: the longest chain by duration.
- `renderDag`: the graph, coloured by status.
- `renderFailures`: the last 60 lines of each failed node's log.

Give `defineWorkflow` a `summary` to change it. For example, with `import { DEFAULT_SUMMARY_RENDERERS, renderTable } from "@mrmeku/dagworkflows"`, `summary: [...DEFAULT_SUMMARY_RENDERERS, renderTable]` adds a table of each node's duration against the last run. `summary: []` turns it off.

A renderer of your own is a `SummaryRenderer`: a function from the `RunReport` to markdown lines. The `RunReport` holds the settled nodes and each one's log. Locally the summary is written to `.dag/summary.md`, so you can try a renderer before you push. The types are in the [API reference](api/index/README.md).

## Pass secrets

Put a secret in the step's `env` and let the command read it from its environment:

```yaml
- uses: mrmeku/dagworkflows@v1
  with:
    workflow: ci.ts
  env:
    GITHUB_TOKEN: ${{ github.token }}
    API_TOKEN: ${{ secrets.API_TOKEN }}
```

A `shell` task then refers to it as `$API_TOKEN`. The workflow file never holds the value, and the command dagworkflows records shows `$API_TOKEN`, not what it holds.

Every command inherits the step's whole environment. In a job that checks out a pull request, the workflow file and every task in it are that pull request's code. So give a step only the secrets you would hand that code.

dagworkflows masks nothing itself. So keep secrets in the step's `env`, and out of everything a task declares: its `cmd` arguments, its `inputs`, its own `env` and its outputs.

> [!IMPORTANT]
> Each task's log is written unmasked beside the CAS, in `.dag/cas.logs/`. Cache `.dag/cas`, never `.dag` or its logs: any pull request can restore an entry of GitHub's cache.

## Cancels on GitHub

When a run is cancelled, nothing new starts and each running command is stopped. GitHub then runs the action's post entry, which pays the post steps the run owes ([Post steps](workflows.md#post-steps)). A post step that fails there too is never paid on a GitHub-hosted runner, so release what it holds by hand ([A post step failed](runs.md#a-post-step-failed-or-an-earlier-run-owes-one)).
