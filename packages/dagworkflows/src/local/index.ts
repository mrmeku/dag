import {
  DEFAULT_FAILURES_REPORT_PATH,
  DEFAULT_LOG_DIR,
  DEFAULT_SUMMARY_PATH,
} from "../config/index.ts";
import { nullArtifactStore } from "../upload-artifact/index.ts";
import type { Platform } from "../wiring/index.ts";

/**
 * Running on a developer's machine: git's context and the terminal on one host, made once; for
 * `run` the terminal in its style with each node's log file and the failures report, and for
 * `post` no display of its own; the worktree cache store, and no artifact store. Its members load
 * only when asked, so a program that never chooses it loads nothing of the local display.
 */
export const localPlatform: Platform = (runtime, { display, command, workflowFile }) => {
  const streams = display.streams ?? process;
  const summaryPath = display.summaryFile ?? DEFAULT_SUMMARY_PATH;
  // The host prints through the terminal once there is one, so its lines land above `live`'s
  // footer and count against `failures`' budget.
  let writeLine: (line: string) => void = (line) => void streams.stdout.write(`${line}\n`);
  let host: ReturnType<ReturnType<Platform>["host"]> | undefined;
  const madeHost = () =>
    (host ??= import("./host/index.ts").then(({ createLocalHost }) =>
      createLocalHost({
        exec: runtime.exec,
        fs: runtime.fs,
        env: runtime.env,
        summaryPath,
        write: (line) => writeLine(line),
      }),
    ));
  return {
    name: "local",
    host: madeHost,
    listeners: async () => {
      if (command === "post") return undefined;
      const [terminal, logFiles, failuresReport, { isAgent, isCI }, localHost] = await Promise.all([
        import("./terminal/index.ts"),
        import("./log-files/index.ts"),
        import("./failures-report/index.ts"),
        import("std-env"),
        madeHost(),
      ]);
      const logDir = display.logDir ?? DEFAULT_LOG_DIR;
      const logs = logFiles.createLogFiles(logDir, runtime.syncFs, localHost);
      const files = {
        logFile: logs.writtenLogFile,
        workflowFile,
        failuresReportPath: display.failuresReportFile ?? DEFAULT_FAILURES_REPORT_PATH,
        logDir,
        summaryPath,
      };
      const style = terminal.outputStyleFor(display.style, {
        isCI,
        isAgent,
        isTerminal: streams.stdout.isTTY === true,
        term: runtime.env.TERM,
      });
      const { listener, printLine } = terminal.createTerminal({
        style,
        files,
        streams,
        clock: runtime.clock,
        host: localHost,
      });
      if (printLine) writeLine = printLine;
      return [
        listener,
        failuresReport.createFailuresReport(files, runtime.syncFs, localHost),
        logs,
      ];
    },
    cacheStore: async () => {
      const { createWorktreeCacheStore } = await import("./cache-store/index.ts");
      return { store: createWorktreeCacheStore(runtime.lockfile) };
    },
    artifactStore: async () => ({ store: nullArtifactStore }),
  };
};
