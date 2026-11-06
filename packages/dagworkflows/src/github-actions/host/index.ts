import type * as actionsCore from "@actions/core";
import type * as actionsGithub from "@actions/github";
import { errorMessage } from "@mrmeku/dagraph";
import { CHECK_TEXT_MAX_CHARS } from "../../config/index.ts";
import { flattenGroups, openStopToken } from "../../github-workflow-commands/index.ts";
import type { CheckUpdate, Host } from "../../host/index.ts";

/** How the toolkit refuses a summary when the step has no summary file. */
const MISSING_SUMMARY_FILE = "Unable to find environment variable for $GITHUB_STEP_SUMMARY";

/**
 * A Host on the toolkit modules it is given: `core` for log groups, annotations and the step
 * summary, `github` for the context and the check runs (needs a `token` with `checks: write`;
 * silently off without one, and switched off after the first API failure so a flaky API can
 * never fail the build). `fetch` is Octokit's. A group's lines are a
 * command's output, replayed: the runner reads its workflow commands, `::add-mask::` included,
 * as it reads a `run:` step's. A check run carries no log, which the runner never masks there:
 * it links to the run's. Its summary keeps the tail GitHub accepts.
 */
export function createActionsHost({
  core,
  github,
  token,
  fetch,
}: {
  core: Pick<
    typeof actionsCore,
    "startGroup" | "endGroup" | "info" | "error" | "warning" | "notice"
  > & {
    summary: Pick<typeof actionsCore.summary, "emptyBuffer" | "addRaw" | "write">;
  };
  github: Pick<typeof actionsGithub, "context" | "getOctokit">;
  token?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}): Host {
  const ctx = github.context;
  const octokit = token ? github.getOctokit(token, fetch && { request: { fetch } }) : undefined;
  const checkIds = new Map<string, number>();
  // A check run the Actions token creates gets its own page as its details_url, whatever is
  // sent, so the link to the run's log goes in the summary, which GitHub renders as markdown.
  const runLog = `[run log](${ctx.serverUrl}/${ctx.repo.owner}/${ctx.repo.repo}/actions/runs/${ctx.runId})`;
  const tail = (s: string) =>
    s.length > CHECK_TEXT_MAX_CHARS
      ? s.slice(-CHECK_TEXT_MAX_CHARS).replace(/^[\uDC00-\uDFFF]/, "")
      : s;
  let checksOff = false;
  // On pull_request events GITHUB_SHA is the merge commit; check runs must target the PR head
  // to show up on the PR.
  const head: unknown = ctx.payload.pull_request?.["head"];
  const headSha =
    typeof head === "object" && head !== null && "sha" in head && typeof head.sha === "string"
      ? head.sha
      : ctx.sha;

  const check = async (u: CheckUpdate) => {
    if (checksOff || !octokit) return;
    try {
      if (u.status === "in_progress") {
        const { data } = await octokit.rest.checks.create({
          ...ctx.repo,
          name: u.name,
          head_sha: headSha,
          status: "in_progress",
          ...(u.startedAt && { started_at: u.startedAt }),
        });
        checkIds.set(u.name, data.id);
        return;
      }
      const completed = {
        status: "completed" as const,
        ...(u.conclusion && { conclusion: u.conclusion }),
        ...(u.startedAt && { started_at: u.startedAt }),
        ...(u.completedAt && { completed_at: u.completedAt }),
        output: {
          title: `${u.name}: ${(u.summary ?? u.conclusion ?? "").split("\n")[0]}`,
          summary: `${tail(u.summary ?? "")}\n\n${runLog}`,
        },
      };
      const id = checkIds.get(u.name);
      if (id === undefined) {
        await octokit.rest.checks.create({
          ...ctx.repo,
          name: u.name,
          head_sha: headSha,
          ...completed,
        });
      } else {
        await octokit.rest.checks.update({ ...ctx.repo, check_run_id: id, ...completed });
      }
    } catch (e) {
      checksOff = true;
      core.notice(`check runs disabled: ${errorMessage(e)}`, {
        title: "dag",
      });
    }
  };

  return {
    context: async () => ({
      isCi: true,
      provider: "github",
      ref: ctx.ref,
      sha: ctx.sha,
      eventName: ctx.eventName,
      actor: ctx.actor,
      runId: ctx.runId,
      repo: ctx.repo,
      serverUrl: ctx.serverUrl,
    }),
    group: (title, lines) => {
      const shown = flattenGroups(lines);
      const open = openStopToken(shown);
      core.startGroup(title);
      for (const line of shown) core.info(line);
      if (open !== undefined) core.info(`::${open}::`);
      core.endGroup();
    },
    info: (line) => core.info(line),
    annotate: (level, title, message) => core[level](message, { title }),
    // Emptied first: `write` empties the buffer only once the file is written, and a refused
    // summary must not reach the next one.
    summary: async (markdown) => {
      try {
        await core.summary.emptyBuffer().addRaw(markdown).write();
      } catch (e) {
        if (!errorMessage(e).startsWith(MISSING_SUMMARY_FILE)) throw e;
        core.info(markdown);
      }
    },
    check,
  };
}
