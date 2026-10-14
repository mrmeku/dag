import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

// `@actions/github` reads the event from the environment when it loads, so the environment is
// set first and the adapter imported after.
const event = join(mkdtempSync(join(tmpdir(), "dagactions-")), "event.json");
writeFileSync(event, JSON.stringify({ pull_request: { head: { sha: "feedface" } } }));
Object.assign(process.env, {
  GITHUB_REPOSITORY: "acme/app",
  GITHUB_SHA: "mergecommit",
  GITHUB_REF: "refs/pull/7/merge",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_EVENT_PATH: event,
  GITHUB_ACTOR: "octocat",
  GITHUB_RUN_ID: "42",
  GITHUB_SERVER_URL: "https://github.com",
});
const { createGithubCi } = await import("./github.ts");

type Call = { method: string; url: string; body: unknown };
const recording = (calls: Call[], status: number): typeof fetch =>
  (async (url, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ id: 7 }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

describe("github adapter", () => {
  test("the context is the toolkit's; check runs target the PR head sha, update by id, carry the flattened log, and create directly when never started", async () => {
    const calls: Call[] = [];
    const ci = createGithubCi({ token: "t", fetch: recording(calls, 201) });
    await ci.check({ name: "typecheck", status: "in_progress", startedAt: "T0" });
    await ci.check({
      name: "typecheck",
      status: "completed",
      conclusion: "success",
      startedAt: "T0",
      completedAt: "T1",
      summary: "done in 1.0s",
      details: "```text\n::group::a.test.ts:\n(pass) a\n::endgroup::\n$ tsgo --noEmit\n```",
    });
    await ci.check({
      name: "gate",
      status: "completed",
      conclusion: "skipped",
      completedAt: "T2",
      summary: "dependency typecheck failed\nmore",
    });
    assert.deepEqual(
      { ctx: await ci.context(), calls },
      {
        ctx: {
          isCi: true,
          provider: "github",
          ref: "refs/pull/7/merge",
          sha: "mergecommit",
          eventName: "pull_request",
          actor: "octocat",
          runId: 42,
          repo: { owner: "acme", repo: "app" },
          serverUrl: "https://github.com",
        },
        calls: [
          {
            method: "POST",
            url: "https://api.github.com/repos/acme/app/check-runs",
            body: {
              name: "typecheck",
              head_sha: "feedface",
              status: "in_progress",
              started_at: "T0",
            },
          },
          {
            method: "PATCH",
            url: "https://api.github.com/repos/acme/app/check-runs/7",
            body: {
              status: "completed",
              conclusion: "success",
              started_at: "T0",
              completed_at: "T1",
              output: {
                title: "typecheck: done in 1.0s",
                summary: "done in 1.0s",
                text: "```text\na.test.ts:\n(pass) a\n$ tsgo --noEmit\n```",
              },
            },
          },
          {
            method: "POST",
            url: "https://api.github.com/repos/acme/app/check-runs",
            body: {
              name: "gate",
              head_sha: "feedface",
              status: "completed",
              conclusion: "skipped",
              completed_at: "T2",
              output: {
                title: "gate: dependency typecheck failed",
                summary: "dependency typecheck failed\nmore",
              },
            },
          },
        ],
      },
    );
  });

  test("an API failure switches checks off after one call instead of failing the build", async () => {
    const calls: Call[] = [];
    const ci = createGithubCi({ token: "t", fetch: recording(calls, 403) });
    await ci.check({ name: "a", status: "in_progress", startedAt: "T0" });
    await ci.check({ name: "b", status: "in_progress", startedAt: "T1" });
    assert.equal(calls.length, 1);
  });
});
