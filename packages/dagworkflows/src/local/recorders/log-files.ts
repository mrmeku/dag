import { plainLine, textOf } from "../../kernel/format.ts";
import * as selectors from "../../kernel/selectors.ts";
import type { RunListener } from "../../kernel/store.ts";
import type { SyncFs } from "../../ports.ts";
import { createWriter } from "./writer.ts";

/** Each `:` or `/` in the name a directory, `.` and `..` encoded, so no name leaves `logDir`. */
function logFileOf(logDir: string, nodeName: string): string {
  const pathSegments = nodeName
    .split(/[:/]/)
    .filter(Boolean)
    .map((segment) =>
      segment === "." || segment === ".." ? segment.replaceAll(".", "%2E") : segment,
    );
  return `${logDir}/${pathSegments.length > 0 ? pathSegments.join("/") : encodeURIComponent(nodeName)}.log`;
}

/**
 * Each node's log as it arrives, so `tail -F` follows it, replaced when its action starts or,
 * for a node that printed nothing as it ran, from the CAS at its settle.
 */
export function createLogFiles(logDir: string, fs: SyncFs, warn: (message: string) => void) {
  const writeFile = createWriter(fs, warn, "log files");
  const writtenNodeNames = new Set<string>();
  const writeLog = (nodeName: string, text: string, append = false) => {
    if (writeFile(logFileOf(logDir, nodeName), text, append)) writtenNodeNames.add(nodeName);
  };
  return {
    immediate: {
      start: (nodeState) => writeLog(nodeState.node.name, ""),
      output: (nodeState, lines) => writeLog(nodeState.node.name, textOf(lines), true),
    },
    settle: (nodeState, _run, log) => {
      if (selectors.logKeyOf(nodeState) && !nodeState.printed)
        writeLog(nodeState.node.name, textOf(log.map((line) => plainLine(line))));
    },
    interrupt: (run) => {
      for (const nodeState of selectors.nodesInFlight(run))
        if (nodeState.unfinishedLine)
          writeLog(nodeState.node.name, textOf([plainLine(nodeState.unfinishedLine)]), true);
    },
    writtenLogFile: (nodeName: string) =>
      writtenNodeNames.has(nodeName) ? logFileOf(logDir, nodeName) : undefined,
  } satisfies RunListener & { writtenLogFile: (nodeName: string) => string | undefined };
}
