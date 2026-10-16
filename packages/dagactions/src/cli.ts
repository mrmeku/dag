#!/usr/bin/env node
import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";
import { Command, Option } from "commander";
import { resolve } from "node:path";
import {
  DEFAULT_CAS_DIR,
  DEFAULT_FAILURES_REPORT_PATH,
  DEFAULT_JOURNAL_PATH,
  DEFAULT_LOG_DIR,
  DEFAULT_SUMMARY_PATH,
  OUTPUT_STYLE_ENV,
  OUTPUT_STYLES,
  type OutputStyle,
} from "./config.ts";
import type { ActionsArtifact, ActionsCache, Ci } from "./ports.ts";
import { artifactServiceAvailable, nullActionsArtifact } from "./ports/actions-artifact.ts";
import { nullActionsCache } from "./ports/actions-cache.ts";
import { createLocalCi } from "./ports/local.ts";
import { abortOnSignals, createSh, systemClock } from "./ports/real.ts";
import { runJob, runPost, type RunOptions } from "./runner.ts";
import type { WorkflowDef } from "./workflow.ts";

export const program = new Command("dagactions").description(
  "Run a CI workflow as a dagraph DAG: on GitHub Actions when GITHUB_ACTIONS=true (workflow commands, step summary, check runs), otherwise locally (terminal output, summary file).",
);

const isGithubActions = process.env.GITHUB_ACTIONS === "true";

/**
 * `@actions/cache` is the cache service when this process can reach it. That takes the runtime
 * token only a JavaScript action receives, so a `run:` step gets a notice and no cache. Locally
 * there is no service, so every restore misses.
 */
async function actionsCacheFor(ci: Ci): Promise<ActionsCache> {
  if (!isGithubActions) return nullActionsCache;
  const cache = await import("@actions/cache");
  if (cache.isFeatureAvailable()) return cache;
  ci.annotate(
    "notice",
    "dagactions",
    "actions/cache is off: this step cannot reach the cache service; run dagactions as the action",
  );
  return nullActionsCache;
}

/** `@actions/artifact` likewise: the service takes the runtime token only the action receives. */
async function actionsArtifactFor(ci: Ci): Promise<ActionsArtifact> {
  if (!isGithubActions) return nullActionsArtifact;
  if (artifactServiceAvailable(process.env)) {
    const { DefaultArtifactClient } = await import("@actions/artifact");
    return new DefaultArtifactClient();
  }
  ci.annotate(
    "notice",
    "dagactions",
    "actions/upload-artifact is off: this step cannot reach the artifact service; run dagactions as the action",
  );
  return nullActionsArtifact;
}

interface CommonOptions {
  only?: string;
  cas: string;
  journal: string;
  summary: string;
}

interface RunCommandOptions extends CommonOptions {
  force?: boolean;
  outputStyle?: OutputStyle;
  logDir: string;
  failuresReport: string;
}

const withCommonOptions = (cmd: Command) =>
  cmd
    .argument("<workflow>", "path to the workflow file")
    .option("--only <names>", "comma-separated nodes to run, with their dependencies")
    .option("--cas <dir>", "local content-addressed cache directory", DEFAULT_CAS_DIR)
    .option("--journal <path>", "where the run records what settled", DEFAULT_JOURNAL_PATH)
    .option(
      "--summary <path>",
      "where the local adapter writes the markdown summary",
      DEFAULT_SUMMARY_PATH,
    );

async function runOptionsFor(
  file: string,
  opts: CommonOptions,
): Promise<RunOptions & { workflowFile: string }> {
  const def = ((await import(resolve(file))) as { default: WorkflowDef }).default;
  const sh = createSh();
  const fs = createNodeDagFs();
  // The GitHub adapter loads Octokit; a local run never needs it.
  const ci = isGithubActions
    ? (await import("./ports/github.ts")).createGithubCi({ token: process.env.GITHUB_TOKEN })
    : createLocalCi({ sh, fs, summaryPath: opts.summary });
  const only = opts.only?.split(",").filter(Boolean);
  return {
    workflow: def.workflow,
    workflowFile: file,
    ports: {
      sh,
      fs,
      clock: systemClock(),
      ci,
      actionsCache: await actionsCacheFor(ci),
      actionsArtifact: await actionsArtifactFor(ci),
      env: process.env,
    },
    casBaseDir: opts.cas,
    journalPath: opts.journal,
    ...(only && { only }),
    ...(def.limits && { limits: def.limits }),
    ...(def.summary && { summary: def.summary }),
  };
}

withCommonOptions(
  program
    .command("run")
    .description("Execute a workflow file that default-exports defineWorkflow(...)")
    .option("--force", "ignore the cache for this run")
    .addOption(
      new Option("--output-style <style>", "terminal output (default: picked from the terminal)")
        .choices(OUTPUT_STYLES)
        .env(OUTPUT_STYLE_ENV),
    )
    .option("--log-dir <dir>", "where each node's log is written as it runs", DEFAULT_LOG_DIR)
    .option(
      "--failures-report <path>",
      "where the report of the run's failures is written",
      DEFAULT_FAILURES_REPORT_PATH,
    ),
).action(async (file: string, opts: RunCommandOptions) => {
  const runOptions = await runOptionsFor(file, opts);
  // Off GitHub a session draws the run in the terminal and records its logs and failures.
  const jobOptions = isGithubActions
    ? runOptions
    : (await import("./local/session.ts")).createLocalSession(runOptions, opts);
  process.exitCode = await runJob(
    { ...jobOptions, force: opts.force ?? false, signal: abortOnSignals() },
    process,
  );
});

withCommonOptions(
  program
    .command("post")
    .description("Run the post steps the last run's journal shows as not reached"),
).action(async (file: string, opts: CommonOptions) => {
  process.exitCode = (await runPost(await runOptionsFor(file, opts))).exitCode;
});

// Node 24.0 and 24.1 have no import.meta.main and would exit 0 here having run nothing.
if (import.meta.main === undefined || Number(process.versions.node.split(".")[0]) < 24) {
  console.error("dagactions needs Node 24.2 or later");
  process.exit(1);
}
// The shell's way to clear a variable, which commander would refuse as an unknown style.
if (process.env[OUTPUT_STYLE_ENV] === "") delete process.env[OUTPUT_STYLE_ENV];
if (import.meta.main) await program.parseAsync();
