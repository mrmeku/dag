import type { DagFs } from "@mrmeku/dagraph";
import type { CheckUpdate, Ci } from "../ports.ts";

/** Escaping rules for GitHub workflow command data and properties. */
export function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

export function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
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

/** The slice of fetch the adapter needs, injectable for tests. */
export type Http = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * GitHub Actions adapter: log groups and annotations become workflow commands on stdout, the
 * summary is appended to $GITHUB_STEP_SUMMARY, the context comes from the GITHUB_* env, and
 * checks become check runs through the REST API (needs GITHUB_TOKEN and `checks: write`;
 * silently off without them, and switched off after the first API failure so a flaky API can
 * never fail the build).
 */
export function createGithubCi(opts: {
  env: Record<string, string | undefined>;
  fs: DagFs;
  write?: (line: string) => void;
  http?: Http;
}): Ci {
  const write = opts.write ?? ((line) => console.log(line));
  const http: Http = opts.http ?? ((url, init) => fetch(url, init));
  const env = opts.env;
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const api = env.GITHUB_API_URL ?? "https://api.github.com";
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  const checkIds = new Map<string, number>();
  let checksOff = !token || !repo;
  let headSha: string | undefined;

  // On pull_request events GITHUB_SHA is the merge commit; check runs must target the PR head
  // to show up on the PR.
  const resolveHeadSha = async (): Promise<string> => {
    if (headSha) return headSha;
    headSha = env.GITHUB_SHA ?? "";
    if (env.GITHUB_EVENT_NAME?.startsWith("pull_request") && env.GITHUB_EVENT_PATH) {
      try {
        const event = JSON.parse(await opts.fs.readText(env.GITHUB_EVENT_PATH)) as {
          pull_request?: { head?: { sha?: string } };
        };
        headSha = event.pull_request?.head?.sha ?? headSha;
      } catch {
        /* fall back to GITHUB_SHA */
      }
    }
    return headSha;
  };

  const call = async (method: string, path: string, body: Record<string, unknown>) => {
    const res = await http(`${api}/repos/${repo}${path}`, {
      method,
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
    return (await res.json()) as { id?: number };
  };

  const check = async (u: CheckUpdate) => {
    if (checksOff) return;
    // GitHub already prefixes a workflow's check runs with the workflow name.
    const name = u.name;
    try {
      if (u.status === "in_progress") {
        const created = await call("POST", "/check-runs", {
          name,
          head_sha: await resolveHeadSha(),
          status: "in_progress",
          started_at: u.startedAt,
        });
        if (created.id !== undefined) checkIds.set(u.name, created.id);
        return;
      }
      const completed = {
        status: "completed",
        conclusion: u.conclusion,
        ...(u.startedAt && { started_at: u.startedAt }),
        completed_at: u.completedAt,
        output: {
          title: `${u.name}: ${(u.summary ?? u.conclusion ?? "").split("\n")[0]}`,
          summary: u.summary ?? "",
          ...(u.details && { text: flattenGroups(u.details.split("\n")).join("\n") }),
        },
      };
      const id = checkIds.get(u.name);
      if (id === undefined) {
        await call("POST", "/check-runs", { name, head_sha: await resolveHeadSha(), ...completed });
      } else {
        await call("PATCH", `/check-runs/${id}`, completed);
      }
    } catch (e) {
      checksOff = true;
      write(
        `::notice title=dagactions::check runs disabled: ${e instanceof Error ? e.message : e}`,
      );
    }
  };

  return {
    context: async () => ({
      isCi: true,
      provider: "github",
      ref: env.GITHUB_REF ?? "",
      sha: env.GITHUB_SHA ?? "",
      eventName: env.GITHUB_EVENT_NAME ?? "",
      actor: env.GITHUB_ACTOR ?? "",
    }),
    group: (title, lines) => {
      write(`::group::${escapeData(title)}`);
      for (const line of flattenGroups(lines)) write(line);
      write("::endgroup::");
    },
    annotate: (level, title, message) => {
      write(`::${level} title=${escapeProperty(title)}::${escapeData(message)}`);
    },
    summary: async (markdown) => {
      const path = env.GITHUB_STEP_SUMMARY;
      if (!path) {
        write(markdown);
        return;
      }
      const existing = (await opts.fs.exists(path)) ? await opts.fs.readText(path) : "";
      await opts.fs.writeText(path, existing + markdown);
    },
    check,
  };
}
