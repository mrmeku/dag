import { createMemoryDagFs } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createGithubCi } from "./github.ts";

describe("github adapter", () => {
  test("emits escaped workflow commands and appends to the step summary", async () => {
    const out: string[] = [];
    const fs = createMemoryDagFs({ "/summary.md": "earlier step\n" });
    const ci = createGithubCi({
      env: { GITHUB_STEP_SUMMARY: "/summary.md", GITHUB_REF: "refs/heads/x", GITHUB_SHA: "abc" },
      fs,
      write: (l) => out.push(l),
    });
    ci.group("✓ build (1.2s)", ["line 1", "::group::a.test.ts:", "line 2", "::endgroup::"]);
    ci.annotate("error", "test:cli, 100%", "exit 1\nlast line: boom");
    await ci.summary("## dagactions\n");
    assert.deepEqual(
      { out, summary: await fs.readText("/summary.md"), ctx: await ci.context() },
      {
        out: [
          "::group::✓ build (1.2s)",
          "line 1",
          "a.test.ts:",
          "line 2",
          "::endgroup::",
          "::error title=test%3Acli%2C 100%25::exit 1%0Alast line: boom",
        ],
        summary: "earlier step\n## dagactions\n",
        ctx: {
          isCi: true,
          provider: "github",
          ref: "refs/heads/x",
          sha: "abc",
          eventName: "",
          actor: "",
        },
      },
    );
  });

  test("check runs target the PR head sha, update by id, carry the log, and create directly when never started", async () => {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const fs = createMemoryDagFs({
      "/event.json": JSON.stringify({ pull_request: { head: { sha: "feedface" } } }),
    });
    const ci = createGithubCi({
      env: {
        GITHUB_TOKEN: "t",
        GITHUB_REPOSITORY: "acme/app",
        GITHUB_SHA: "mergecommit",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: "/event.json",
      },
      fs,
      http: async (url, init) => {
        calls.push({ method: init.method, url, body: JSON.parse(init.body) });
        return { ok: true, status: 201, json: async () => ({ id: 7 }) };
      },
    });
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
    assert.deepEqual(calls, [
      {
        method: "POST",
        url: "https://api.github.com/repos/acme/app/check-runs",
        body: { name: "typecheck", head_sha: "feedface", status: "in_progress", started_at: "T0" },
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
    ]);
  });

  test("an API failure switches checks off with one notice instead of failing the build", async () => {
    const out: string[] = [];
    let calls = 0;
    const ci = createGithubCi({
      env: { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "acme/app", GITHUB_SHA: "abc" },
      fs: createMemoryDagFs(),
      write: (l) => out.push(l),
      http: async () => {
        calls++;
        return { ok: false, status: 403, json: async () => ({}) };
      },
    });
    await ci.check({ name: "a", status: "in_progress", startedAt: "T0" });
    await ci.check({ name: "b", status: "in_progress", startedAt: "T1" });
    assert.deepEqual(
      { calls, out },
      {
        calls: 1,
        out: ["::notice title=dagactions::check runs disabled: POST /check-runs -> 403"],
      },
    );
  });
});
