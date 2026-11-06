import { errorMessage } from "@mrmeku/dagraph";
import { dirname } from "node:path";
import type { Host } from "../../host/index.ts";
import { plainLine, selectors, textOf } from "../../kernel/index.ts";
import type { RunListener } from "../../run-store/index.ts";
import type { SyncFileSystem } from "../../wiring/index.ts";

/**
 * A listener's writes, synchronous so its files are whole when the process is forced out. The
 * first that fails warns on the host, and the writes stop there: a full disk never stops the run.
 */
function createWriter(syncFs: SyncFileSystem, host: Host, listenerName: string) {
  const madeDirectories = new Set<string>();
  let disabled = false;
  return (path: string, text: string, append = false): boolean => {
    if (disabled) return false;
    try {
      if (!madeDirectories.has(dirname(path))) syncFs.mkdirSync(dirname(path), { recursive: true });
      madeDirectories.add(dirname(path));
      if (append) syncFs.appendFileSync(path, text);
      else syncFs.writeFileSync(path, text);
      return true;
    } catch (e) {
      disabled = true;
      host.annotate("warning", "dag", `${listenerName} off: ${errorMessage(e)}`);
      return false;
    }
  };
}

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
 * for a cache hit, which prints nothing as it runs, from its build log at its settle.
 */
export function createLogFiles(logDir: string, syncFs: SyncFileSystem, host: Host) {
  const writeFile = createWriter(syncFs, host, "log files");
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
      if (nodeState.status === "succeeded" && !nodeState.result.details.actionRan)
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
