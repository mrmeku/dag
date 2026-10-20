import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { styleText } from "node:util";
import { quote } from "shlex";
import { isAgent, isCI } from "std-env";
import { createSupportsHyperlinks } from "supports-hyperlinks";
import {
  DEFAULT_FAILURES_REPORT_PATH,
  DEFAULT_LOG_DIR,
  DEFAULT_SUMMARY_PATH,
  RERUN_COMMAND,
  type OutputStyle,
} from "../config.ts";
import { createGithubRenderer } from "../github/renderer.ts";
import { createRunStore, type RunStore } from "../kernel/store.ts";
import type { SyncFs } from "../ports.ts";
import { createLocalCi } from "../ports/local.ts";
import { syncFs as nodeSyncFs } from "../ports/real.ts";
import type { RunOptions } from "../runner.ts";
import { createFailuresReport } from "./recorders/failures-report.ts";
import { createLogFiles } from "./recorders/log-files.ts";
import { createAgentRenderer } from "./terminal/agent.ts";
import type { WriteStreams } from "./terminal/frame.ts";
import { createLiveRenderer } from "./terminal/live.ts";
import type { LocalContext } from "./words.ts";

/** A style asked for wins; then CI gets grouped, an agent failures even in a PTY, a terminal live. */
function outputStyleFor(chosenStyle: OutputStyle | undefined, isTerminal: boolean): OutputStyle {
  if (chosenStyle) return chosenStyle;
  if (isCI) return "grouped";
  if (isAgent) return "failures";
  return isTerminal && process.env.TERM !== "dumb" ? "live" : "grouped";
}

/**
 * `runOptions` drawn and recorded locally, on the process's terminal and files unless given others: in
 * the style asked for or picked, `grouped` being GitHub's renderer on the local adapter, with
 * each node's log file and failures.md beside it. The terminal hears the run first, so a
 * recorder's warning prints under its title and the recorders finish before its last lines.
 */
export function createLocalSession(
  runOptions: RunOptions & { workflowFile: string },
  {
    outputStyle,
    summaryFile = DEFAULT_SUMMARY_PATH,
    logDir = DEFAULT_LOG_DIR,
    failuresReportFile = DEFAULT_FAILURES_REPORT_PATH,
    streams = process,
    syncFs = nodeSyncFs,
  }: {
    outputStyle?: OutputStyle | undefined;
    summaryFile?: string;
    logDir?: string;
    failuresReportFile?: string;
    streams?: WriteStreams;
    syncFs?: SyncFs;
  },
): RunOptions & { store: RunStore } {
  const { sh, fs, clock } = runOptions.ports;
  const style = outputStyleFor(outputStyle, streams.stdout.isTTY === true);
  const useColor = style === "live" && streams.stdout.hasColors?.() === true;
  const useHyperlinks = style === "live" && createSupportsHyperlinks(streams.stdout);
  const rerunCommand = `${RERUN_COMMAND} ${quote(runOptions.workflowFile)}`;
  // The Ci prints through the terminal, which names the log files, which warn through the Ci.
  const warn = (message: string) => ci.annotate("warning", "dagactions", message);
  const logFiles = createLogFiles(logDir, syncFs, warn);
  const localContext: LocalContext = {
    paint: (textStyle, text) =>
      useColor && text ? styleText(textStyle, text, { validateStream: false }) : text,
    link: (path) =>
      useHyperlinks
        ? `\x1b]8;;${pathToFileURL(resolve(path)).href}\x1b\\${path}\x1b]8;;\x1b\\`
        : path,
    logFile: logFiles.writtenLogFile,
    rerunCommand,
    workflowFile: runOptions.workflowFile,
    failuresReportPath: failuresReportFile,
    logDir,
    summaryPath: summaryFile,
  };
  const terminalRenderer =
    style === "live"
      ? createLiveRenderer(localContext, streams, clock, runOptions.limits, () => store.getState())
      : style === "failures"
        ? createAgentRenderer(localContext, (text) => void streams.stdout.write(text))
        : undefined;
  const writeLine =
    terminalRenderer?.printLine ?? ((line: string) => void streams.stdout.write(`${line}\n`));
  const ci = createLocalCi({ sh, fs, summaryPath: summaryFile, write: writeLine });
  const store = createRunStore({
    fs,
    clock,
    casBaseDir: runOptions.casBaseDir,
    lastRunAtBegin: true,
    listeners: [
      terminalRenderer ?? createGithubRenderer(ci),
      createFailuresReport(localContext, syncFs, warn),
      logFiles,
    ],
  });
  return { ...runOptions, ports: { ...runOptions.ports, ci }, rerunCommand, store };
}
