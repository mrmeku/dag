#!/usr/bin/env node
import { Command, Option, type OptionValues } from "@commander-js/extra-typings";
import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";
import { resolve } from "node:path";
import { check, lock } from "proper-lockfile";
import {
  DEFAULT_CAS_DIR,
  DEFAULT_FAILURES_REPORT_PATH,
  DEFAULT_HISTORY_DIR,
  DEFAULT_LOG_DIR,
  DEFAULT_SUMMARY_PATH,
  OUTPUT_STYLE_ENV,
  OUTPUT_STYLES,
} from "./config.ts";
import { createLocalHost } from "./ports/local.ts";
import { abortOnSignals, createExec, systemClock } from "./ports/real.ts";
import { runJob, runPost, type RunOptions } from "./runner.ts";
import { peer, pickActionsArtifact, pickActionsCache } from "./services.ts";
import { workflowDefOf } from "./workflow.ts";

export const program = new Command("dag").description(
  "Run a CI workflow as a dagraph DAG: on GitHub Actions when GITHUB_ACTIONS=true (workflow commands, step summary, check runs), otherwise locally (terminal output, summary file).",
);

const withCommonOptions = <Options extends OptionValues>(cmd: Command<[], Options>) =>
  cmd
    .argument("<workflow>", "path to the workflow file")
    .option(
      "--only <names>",
      "comma-separated nodes to run, with the post steps of what runs, each with its dependencies",
    )
    .option("--cas-dir <dir>", "local content-addressed cache directory", DEFAULT_CAS_DIR)
    .option(
      "--history-dir <dir>",
      "where each run records what started and settled, in a history of its own",
      DEFAULT_HISTORY_DIR,
    )
    .option(
      "--summary-file <file>",
      "where the local adapter writes the markdown summary",
      DEFAULT_SUMMARY_PATH,
    );

const isGithubActions = process.env.GITHUB_ACTIONS === "true";

async function runOptionsFor(
  file: string,
  opts: CommonOptions,
): Promise<RunOptions & { workflowFile: string }> {
  const def = workflowDefOf(await import(resolve(file)), file);
  const exec = createExec();
  const fs = createNodeDagFs();
  // The GitHub adapter loads Octokit; a local run never needs it.
  const host = isGithubActions
    ? (await peer(() => import("./ports/github.ts"))).createGithubHost({
        token: process.env.GITHUB_TOKEN,
      })
    : createLocalHost({ exec, fs, summaryPath: opts.summaryFile });
  const only = opts.only?.split(",").filter(Boolean);
  return {
    implementation: def.implementation,
    workflowFile: file,
    ports: {
      exec,
      fs,
      clock: systemClock(),
      host,
      actionsCache: await pickActionsCache(process.env, host),
      actionsArtifact: await pickActionsArtifact(process.env, host),
      lockfile: { lock, check },
      env: process.env,
    },
    casBaseDir: opts.casDir,
    historyDir: opts.historyDir,
    ...(only && { only }),
    ...(def.schedulerOptions && { schedulerOptions: def.schedulerOptions }),
    ...(def.summary && { summary: def.summary }),
  };
}

const runCommand = withCommonOptions(
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
      "--failures-report-file <file>",
      "where the report of the run's failures is written",
      DEFAULT_FAILURES_REPORT_PATH,
    ),
);
/** The options of `run`, as commander parses them. */
export type RunCommandOptions = ReturnType<typeof runCommand.opts>;

runCommand.action(async (file, opts) => {
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

const postCommand = withCommonOptions(
  program
    .command("post")
    .description("Run the post steps that stopped runs' histories show as still owed"),
);
/** The options `run` and `post` share; `post` has no others. */
type CommonOptions = ReturnType<typeof postCommand.opts>;

postCommand.action(async (file, opts) => {
  process.exitCode = (await runPost(await runOptionsFor(file, opts))).exitCode;
});

// Node 24.0 and 24.1 have no import.meta.main and would exit 0 here having run nothing.
if (!("main" in import.meta) || Number(process.versions.node.split(".")[0]) < 24) {
  console.error("dag needs Node 24.2 or later");
  process.exit(1);
}
// The shell's way to clear a variable, which commander would refuse as an unknown style.
if (process.env[OUTPUT_STYLE_ENV] === "") delete process.env[OUTPUT_STYLE_ENV];
if (import.meta.main) await program.parseAsync();
