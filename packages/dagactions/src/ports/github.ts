import * as core from "@actions/core";
import * as github from "@actions/github";
import type { CheckUpdate, Ci } from "../ports.ts";

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
 * can never fail the build). `fetch` is Octokit's, injectable for tests.
 */
export function createGithubCi(
  opts: { token?: string | undefined; fetch?: typeof fetch } = {},
): Ci {
  const ctx = github.context;
  const octokit = opts.token
    ? github.getOctokit(opts.token, opts.fetch && { request: { fetch: opts.fetch } })
    : undefined;
  const checkIds = new Map<string, number>();
  let checksOff = octokit === undefined;
  // On pull_request events GITHUB_SHA is the merge commit; check runs must target the PR head
  // to show up on the PR.
  const headSha =
    (ctx.payload.pull_request?.["head"] as { sha?: string } | undefined)?.sha ?? ctx.sha;

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
          summary: u.summary ?? "",
          ...(u.details && { text: flattenGroups(u.details.split("\n")).join("\n") }),
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
      core.notice(`check runs disabled: ${e instanceof Error ? e.message : String(e)}`, {
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
      core.startGroup(title);
      for (const line of flattenGroups(lines)) core.info(line);
      core.endGroup();
    },
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
