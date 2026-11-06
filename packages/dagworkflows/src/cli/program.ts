import { Command, Option, type OptionValues } from "@commander-js/extra-typings";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_CACHE_DIR, OUTPUT_STYLES } from "../config/index.ts";
import {
  githubActionsPlatform,
  type ToolkitLoader,
  type ToolkitModules,
} from "../github-actions/index.ts";
import { localPlatform } from "../local/index.ts";
import { nodejsRuntime } from "../nodejs/index.ts";
import { runJob, runPost } from "../run/index.ts";
import { processPorts, type DagCommand, type DisplayOptions } from "../wiring/index.ts";
import { workflowOf } from "../workflow/index.ts";

/** Overrides the style the CLI picks; `--output-style` overrides this. */
export const OUTPUT_STYLE_ENV = "DAG_OUTPUT_STYLE";

const PLATFORMS = ["github-actions", "local"] as const;
const STORES = [...PLATFORMS, "none"] as const;

const TOOLKIT: { [Name in keyof ToolkitModules]: () => Promise<ToolkitModules[Name]> } = {
  "@actions/core": () => import("@actions/core"),
  "@actions/github": () => import("@actions/github"),
  "@actions/cache": () => import("@actions/cache"),
  "@actions/artifact": () => import("@actions/artifact"),
};

/**
 * The toolkit as the CLI loads it: optional peer dependencies, a missing one named with what to
 * do about it, and `@actions/cache` only when a cache variable says this step can reach it.
 */
const cliToolkit: ToolkitLoader = {
  load: async (name) => {
    try {
      return await TOOLKIT[name]();
    } catch (e) {
      if (!String(e).includes(`Cannot find package '${name}'`)) throw e;
      throw new Error(
        `dag needs ${name} on GitHub, an optional peer dependency it does not install: ` +
          `add it (npm install --save-dev ${name}), or use the action, which bundles it, instead of \`dag run\``,
        { cause: e },
      );
    }
  },
  cacheVariablesRequired: true,
  notices: {
    cache:
      "actions/cache is off: this step cannot reach the cache service; use the action instead of `dag run`",
    artifact:
      "actions/upload-artifact is off: this step cannot reach the artifact service; use the action instead of `dag run`",
  },
};

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
    .option("--cache-dir <dir>", "local content-addressed cache directory", DEFAULT_CACHE_DIR)
    .option(
      "--history-dir <dir>",
      "where each run records what started and settled, in a history of its own",
    )
    .option("--summary-file <file>", "where the local platform writes the markdown summary")
    .addOption(
      new Option(
        "--platform <platform>",
        "where the run reports (default: from GITHUB_ACTIONS)",
      ).choices(PLATFORMS),
    )
    .addOption(
      new Option(
        "--cache-store <store>",
        "the platform whose cache store a cache uses, or none",
      ).choices(STORES),
    )
    .addOption(
      new Option(
        "--artifact-store <store>",
        "the platform whose artifact store an upload uses, or none",
      ).choices(STORES),
    );

const runCommand = withCommonOptions(
  program
    .command("run")
    .description("Execute a workflow file that default-exports defineWorkflow(...)")
    .option("--force", "run every node: no lookup in the cache dir hits")
    .addOption(
      new Option("--output-style <style>", "terminal output (default: picked from the terminal)")
        .choices(OUTPUT_STYLES)
        .env(OUTPUT_STYLE_ENV),
    )
    .option("--log-dir <dir>", "where each node's log is written as it runs")
    .option("--failures-report-file <file>", "where the report of the run's failures is written"),
);

const postCommand = withCommonOptions(
  program
    .command("post")
    .description("Run the post steps that stopped runs' histories show as still owed"),
);

/** The options `run` and `post` share; `post` has no others. */
type CommonOptions = ReturnType<typeof postCommand.opts>;

/** The run options of a workflow file, its process wired for `command`. */
async function runOptionsFor(
  file: string,
  opts: CommonOptions,
  command: DagCommand,
  display: DisplayOptions,
) {
  const def = workflowOf(await import(pathToFileURL(resolve(file)).href), file);
  const only = opts.only?.split(",").filter(Boolean);
  const paths = {
    cacheDir: opts.cacheDir,
    ...(opts.historyDir && { historyDir: opts.historyDir }),
  };
  const { ports, store } = await processPorts({
    runtime: nodejsRuntime,
    platforms: [localPlatform, githubActionsPlatform(cliToolkit)],
    choices: {
      platform: opts.platform,
      cacheStore: opts.cacheStore,
      artifactStore: opts.artifactStore,
    },
    display: { ...display, summaryFile: opts.summaryFile },
    paths,
    workflowFile: file,
    command,
    notices: true,
  });
  return {
    ...def,
    ...paths,
    ports,
    workflowFile: file,
    ...(store && { store }),
    ...(only && { only }),
  };
}

runCommand.action(async (file, opts) => {
  const runOptions = await runOptionsFor(file, opts, "run", {
    style: opts.outputStyle,
    logDir: opts.logDir,
    failuresReportFile: opts.failuresReportFile,
  });
  process.exitCode = await runJob(
    { ...runOptions, force: opts.force ?? false, signal: nodejsRuntime.abortOnSignals() },
    process,
  );
});

postCommand.action(async (file, opts) => {
  process.exitCode = (await runPost(await runOptionsFor(file, opts, "post", {}))).exitCode;
});
