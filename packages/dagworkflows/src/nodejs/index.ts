import type { Runtime } from "../wiring/index.ts";
import { startGlobalTimer, systemClock } from "./clock/index.ts";
import { abortOnSignals, createExec } from "./exec/index.ts";
import { fileMatcher } from "./file-matcher/index.ts";
import { createNodeWorkflowFileSystem, syncFs } from "./file-system/index.ts";
import { lockfile } from "./lockfile/index.ts";

export { systemClock } from "./clock/index.ts";
export { abortOnSignals, createExec } from "./exec/index.ts";

/** The process on Node.js: its child processes, clock, files, locks, the working tree and `process.env`. */
export const nodejsRuntime: Runtime = {
  exec: createExec(),
  clock: systemClock(),
  startTimer: startGlobalTimer,
  fs: createNodeWorkflowFileSystem(),
  syncFs,
  lockfile,
  fileMatcher,
  env: process.env,
  abortOnSignals,
};

/** GitHub's `hashFiles()` of the patterns: "" when nothing matches. */
export const hashFiles = (patterns: string[]): Promise<string> => fileMatcher.hash(patterns);
