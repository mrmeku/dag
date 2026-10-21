import * as core from "@actions/core";
import * as github from "@actions/github";
import { CHECK_TEXT_MAX_CHARS } from "../config.ts";
import { errorMessage } from "../kernel/format.ts";
import type { CheckUpdate, Ci } from "../ports.ts";

/**
 * The token of a `::stop-commands::` the lines leave open. On GitHub one ends with its step, and
 * every node's log replays in this one step, so the group that opened it resumes it.
 */
export function openStopToken(lines: string[]): string | undefined {
  let token: string | undefined;
  for (const raw of lines.flatMap((l) => l.split("\r"))) {
    // .NET's TrimStart, which the runner uses, also strips U+0085.
    const line = raw.replace(/^[\s\u0085]+/, "");
    const lower = line.toLowerCase();
    if (token === undefined && lower.startsWith("::stop-commands::")) token = line.slice(17);
    else if (token !== undefined && lower.startsWith(`::${token.toLowerCase()}::`))
      token = undefined;
  }
  return token;
}

/**
 * GitHub does not nest log groups: a tool's own `::group::` inside a node's group would end the
 * node's group early. Its title stays as a plain line; `::endgroup::` goes.
 */
export function flattenGroups(lines: string[]): string[] {
  return lines.flatMap((line) =>
    line.startsWith("::endgroup::") ? [] : line.startsWith("::group::") ? [line.slice(9)] : [line],
  );
}

/**
 * GitHub Actions adapter: `@actions/core` for log groups, annotations and the step summary,
 * `@actions/github` for the context and the check runs (needs `GITHUB_TOKEN` and `checks: write`;
 * silently off without the token, and switched off after the first API failure so a flaky API
 * can never fail the build). `fetch` is Octokit's, injectable for tests. A group's lines are a
 * command's output, replayed: the runner reads its workflow commands, `::add-mask::` included,
 * as it reads a `run:` step's. A check run carries no log, which the runner never masks there:
 * it links to the run's. Its summary keeps the tail GitHub accepts.
 */
export function createGithubCi(
  opts: { token?: string | undefined; fetch?: typeof fetch } = {},
): Ci {
  const ctx = github.context;
  const octokit = opts.token
    ? github.getOctokit(opts.token, opts.fetch && { request: { fetch: opts.fetch } })
    : undefined;
  const checkIds = new Map<string, number>();
  // A check run the Actions token creates gets its own page as its details_url, whatever is
  // sent, so the link to the run's log goes in the summary, which GitHub renders as markdown.
  const runLog = `[run log](${ctx.serverUrl}/${ctx.repo.owner}/${ctx.repo.repo}/actions/runs/${ctx.runId})`;
  const tail = (s: string) =>
    s.length > CHECK_TEXT_MAX_CHARS
      ? s.slice(-CHECK_TEXT_MAX_CHARS).replace(/^[\uDC00-\uDFFF]/, "")
      : s;
  let checksOff = octokit === undefined;
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
        title: "dagactions",
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
    summary: async (markdown) => {
      if (!process.env["GITHUB_STEP_SUMMARY"]) {
        core.info(markdown);
        return;
      }
      await core.summary.addRaw(markdown).write();
    },
    check,
  };
}
