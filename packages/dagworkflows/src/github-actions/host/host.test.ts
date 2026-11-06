import type * as actionsCore from "@actions/core";
import { getOctokit } from "@actions/github";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { warningsOf } from "../../github-workflow-commands/index.ts";
import { createActionsHost } from "./index.ts";

/** How the toolkit refuses a summary when the step has no summary file. */
const MISSING_SUMMARY_FILE =
  "Unable to find environment variable for $GITHUB_STEP_SUMMARY. Check if your runtime environment supports job summaries.";

/**
 * A `core` double: the log as the toolkit prints it, each annotation, and a summary that keeps a
 * buffer as the toolkit's does, emptied by `emptyBuffer` and by a write that lands, and whose
 * every write refuses with `refusal`, recording the buffer it was given.
 */
function coreDouble(refusal = new Error(MISSING_SUMMARY_FILE)) {
  const log: string[] = [];
  const annotations: Array<{ level: string; message: string; title: string | undefined }> = [];
  const written: string[] = [];
  let buffer = "";
  const summary = {
    emptyBuffer: () => ((buffer = ""), summary),
    addRaw: (text: string) => ((buffer += text), summary),
    write: async () => {
      written.push(buffer);
      throw refusal;
    },
  };
  const annotate =
    (level: string) => (message: string | Error, props?: actionsCore.AnnotationProperties) =>
      void annotations.push({ level, message: String(message), title: props?.title });
  const core = {
    startGroup: (title: string) => void log.push(`::group::${title}`),
    info: (line: string) => void log.push(line),
    endGroup: () => void log.push("::endgroup::"),
    error: annotate("error"),
    warning: annotate("warning"),
    notice: annotate("notice"),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the toolkit's Summary has private fields, so no double is one structurally; this one keeps and refuses as it does
    summary: summary as unknown as typeof actionsCore.summary,
  };
  return { core, log, annotations, written };
}

/** A pull request's context, as `@actions/github` reads it from the runner's environment. */
const context = {
  payload: { pull_request: { number: 7, head: { sha: "feedface" } } },
  eventName: "pull_request",
  sha: "mergecommit",
  ref: "refs/pull/7/merge",
  workflow: "ci",
  action: "dag",
  actor: "octocat",
  job: "build",
  runAttempt: 1,
  runNumber: 3,
  runId: 42,
  apiUrl: "https://api.github.com",
  serverUrl: "https://github.com",
  graphqlUrl: "https://api.github.com/graphql",
  issue: { owner: "acme", repo: "app", number: 7 },
  repo: { owner: "acme", repo: "app" },
};
const github = { context, getOctokit };

const RUN_LOG = "[run log](https://github.com/acme/app/actions/runs/42)";

type Call = { method: string; url: string; body: unknown };
/** A `fetch` double: each call recorded, answered with a created check run, or rejected while `failing` lasts. */
const fetchDouble = (calls: Call[], failing = 0): typeof fetch => {
  const record = async (...[url, init]: Parameters<typeof fetch>) => {
    calls.push({
      method: init?.method ?? "GET",
      url: url instanceof Request ? url.url : url.toString(),
      body: typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined,
    });
    if (calls.length <= failing) throw new Error("connection reset");
    return new Response(JSON.stringify({ id: 7 }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };
  return Object.assign(record, { preconnect: () => {} });
};

describe("the GitHub host", () => {
  test("a group's tool groups are flattened, and a stop-commands it leaves open is resumed before it ends, so the next group's warning is read", () => {
    const { core, log } = coreDouble();
    const host = createActionsHost({ core, github });
    host.group("✔ build (1.2s)", [
      "::group::a.test.ts:",
      "token",
      "::endgroup::",
      "::stop-commands::tok",
    ]);
    host.group("✘ lint (0.1s)", ["::warning::w"]);
    assert.deepEqual(
      { log, warnings: warningsOf(log).map((warning) => warning.message) },
      {
        log: [
          "::group::✔ build (1.2s)",
          "a.test.ts:",
          "token",
          "::stop-commands::tok",
          "::tok::",
          "::endgroup::",
          "::group::✘ lint (0.1s)",
          "::warning::w",
          "::endgroup::",
        ],
        warnings: ["w"],
      },
    );
  });

  test("the context is the toolkit's; check runs target the PR head sha, update by id, link to the run, and create directly when never started", async () => {
    const calls: Call[] = [];
    const { core } = coreDouble();
    const host = createActionsHost({ core, github, token: "t", fetch: fetchDouble(calls) });
    await host.check({ name: "typecheck", status: "in_progress", startedAt: "T0" });
    await host.check({
      name: "typecheck",
      status: "completed",
      conclusion: "success",
      startedAt: "T0",
      completedAt: "T1",
      summary: "done in 1.0s",
    });
    await host.check({
      name: "require-all",
      status: "completed",
      conclusion: "skipped",
      completedAt: "T2",
      summary: "dependency typecheck failed\nmore",
    });
    assert.deepEqual(
      { ctx: await host.context(), calls },
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
                summary: `done in 1.0s\n\n${RUN_LOG}`,
              },
            },
          },
          {
            method: "POST",
            url: "https://api.github.com/repos/acme/app/check-runs",
            body: {
              name: "require-all",
              head_sha: "feedface",
              status: "completed",
              conclusion: "skipped",
              completed_at: "T2",
              output: {
                title: "require-all: dependency typecheck failed",
                summary: `dependency typecheck failed\nmore\n\n${RUN_LOG}`,
              },
            },
          },
        ],
      },
    );
  });

  test("off a pull request, a check run targets the context's sha", async () => {
    const calls: Call[] = [];
    const { core } = coreDouble();
    const push = { ...context, payload: {}, eventName: "push", sha: "abc", ref: "refs/heads/main" };
    const host = createActionsHost({
      core,
      github: { context: push, getOctokit },
      token: "t",
      fetch: fetchDouble(calls),
    });
    await host.check({ name: "typecheck", status: "in_progress", startedAt: "T0" });
    assert.deepEqual(calls, [
      {
        method: "POST",
        url: "https://api.github.com/repos/acme/app/check-runs",
        body: { name: "typecheck", head_sha: "abc", status: "in_progress", started_at: "T0" },
      },
    ]);
  });

  test("the first failed check-run call posts one notice and ends check runs, every check resolving", async () => {
    const calls: Call[] = [];
    const { core, annotations } = coreDouble();
    const host = createActionsHost({
      core,
      github,
      token: "t",
      fetch: fetchDouble(calls, 1),
    });
    const checks = [];
    for (const update of [
      { name: "a", status: "in_progress", startedAt: "T0" },
      { name: "b", status: "in_progress", startedAt: "T1" },
      { name: "a", status: "completed", conclusion: "success" },
    ] as const)
      checks.push(
        await host.check(update).then(
          () => "resolved",
          () => "rejected",
        ),
      );
    assert.deepEqual(
      { calls: calls.length, annotations, checks },
      {
        calls: 1,
        annotations: [
          { level: "notice", message: "check runs disabled: connection reset", title: "dag" },
        ],
        checks: ["resolved", "resolved", "resolved"],
      },
    );
  });

  test("a check run's summary keeps the tail GitHub accepts, then the link to the run's log", async () => {
    const calls: Call[] = [];
    const { core } = coreDouble();
    const host = createActionsHost({ core, github, token: "t", fetch: fetchDouble(calls) });
    const long = `${"x".repeat(70_000)}END`;
    await host.check({ name: "n", status: "completed", conclusion: "failure", summary: long });
    assert.deepEqual(calls, [
      {
        method: "POST",
        url: "https://api.github.com/repos/acme/app/check-runs",
        body: {
          name: "n",
          head_sha: "feedface",
          status: "completed",
          conclusion: "failure",
          output: { title: `n: ${long}`, summary: `${"x".repeat(64_997)}END\n\n${RUN_LOG}` },
        },
      },
    ]);
  });

  test("a summary refused for want of a summary file is printed into the log, each holding only its own markdown, as each write was given only its own", async () => {
    const { core, log, written } = coreDouble();
    const host = createActionsHost({ core, github });
    await host.summary("## one");
    await host.summary("## two");
    assert.deepEqual(
      { log, written },
      { log: ["## one", "## two"], written: ["## one", "## two"] },
    );
  });

  test("a summary refused for any other reason rejects, and is not printed", async () => {
    const { core, log } = coreDouble(new Error("EACCES: permission denied"));
    const host = createActionsHost({ core, github });
    const refused = await host.summary("## one").then(
      () => "written",
      (e: unknown) => (e instanceof Error ? e.message : e),
    );
    assert.deepEqual({ refused, log }, { refused: "EACCES: permission denied", log: [] });
  });
});
