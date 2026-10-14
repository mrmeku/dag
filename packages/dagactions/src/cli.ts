#!/usr/bin/env node
import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";
import { Command } from "commander";
import { resolve } from "node:path";
import { DEFAULT_CAS_DIR, DEFAULT_JOURNAL_PATH, DEFAULT_SUMMARY_PATH } from "./config.ts";
import type { ActionsArtifact, ActionsCache, Ci } from "./ports.ts";
import { artifactServiceAvailable, nullActionsArtifact } from "./ports/actions-artifact.ts";
import { nullActionsCache } from "./ports/actions-cache.ts";
import { createLocalCi } from "./ports/local.ts";
import { abortOnSignals, createSh, systemClock } from "./ports/real.ts";
import { runPost, runWorkflow, type RunOptions } from "./runner.ts";
import type { WorkflowDef } from "./workflow.ts";

export const program = new Command("dagactions").description(
  "Run a CI workflow as a dagraph DAG: on GitHub Actions when GITHUB_ACTIONS=true (workflow commands, step summary, check runs), otherwise locally (terminal output, summary file).",
);

/**
 * `@actions/cache` is the cache service when this process can reach it. That takes the runtime
 * token only a JavaScript action receives, so a `run:` step gets a notice and no cache. Locally
 * there is no service, so every restore misses.
 */
async function pickActionsCache(onGithub: boolean, ci: Ci): Promise<ActionsCache> {
  if (!onGithub) return nullActionsCache;
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
async function pickActionsArtifact(onGithub: boolean, ci: Ci): Promise<ActionsArtifact> {
  if (!onGithub) return nullActionsArtifact;
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

async function options(file: string, opts: CommonOptions): Promise<RunOptions> {
  const def = ((await import(resolve(file))) as { default: WorkflowDef }).default;
  const sh = createSh();
  const fs = createNodeDagFs();
  const onGithub = process.env.GITHUB_ACTIONS === "true";
  // The GitHub adapter loads Octokit; a local run never needs it.
  const ci = onGithub
    ? (await import("./ports/github.ts")).createGithubCi({ token: process.env.GITHUB_TOKEN })
    : createLocalCi({ sh, fs, summaryPath: opts.summary });
  const only = opts.only?.split(",").filter(Boolean);
  return {
    workflow: def.workflow,
    ports: {
      sh,
      fs,
      clock: systemClock(),
      ci,
      actionsCache: await pickActionsCache(onGithub, ci),
      actionsArtifact: await pickActionsArtifact(onGithub, ci),
    },
    casBaseDir: opts.cas,
    journalPath: opts.journal,
    ...(only && { only }),
    ...(def.limits && { limits: def.limits }),
  };
}

withCommonOptions(
  program
    .command("run")
    .description("Execute a workflow file that default-exports defineWorkflow(...)")
    .option("--force", "ignore the cache for this run"),
).action(async (file: string, opts: CommonOptions & { force?: boolean }) => {
  const common = await options(file, opts);
  const { failed, cancelled } = await runWorkflow({
    ...common,
    force: opts.force ?? false,
    signal: abortOnSignals(),
  });
  // No runner here to start a post step after a cancel, so this process runs the post steps.
  const post = cancelled ? await runPost(common) : { failed: 0 };
  process.exitCode = cancelled ? 130 : failed + post.failed > 0 ? 1 : 0;
});

withCommonOptions(
  program
    .command("post")
    .description("Run the post steps the last run's journal shows as not reached"),
).action(async (file: string, opts: CommonOptions) => {
  const { failed } = await runPost(await options(file, opts));
  process.exitCode = failed > 0 ? 1 : 0;
});

// An older Node has no import.meta.main and would exit 0 here having run nothing.
if (import.meta.main === undefined) throw new Error("dagactions needs Node 22.18 or later");
if (import.meta.main) await program.parseAsync();
