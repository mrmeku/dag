import type { MemoryFileSystem } from "@mrmeku/dagraph";
import type { Runtime } from "../wiring/index.ts";
import { manualTimer, steppingClock } from "./clock/index.ts";
import { okExec } from "./exec/index.ts";
import { createMemoryFileMatcher } from "./file-matcher/index.ts";
import { createMemoryWorkflowFileSystem } from "./file-system/index.ts";
import { createMemoryLockfile, type MemoryLockfile } from "./lockfile/index.ts";

export { clockAt, manualTimer, steppingClock } from "./clock/index.ts";
export { okExec } from "./exec/index.ts";

/**
 * A fresh process of in-memory doubles: every command succeeds, a stepping clock unless one is
 * given, timers that fire only by hand, files in memory seeded with `files`, locks in memory on
 * the clock, a file matcher over `matches`, an empty environment, and a cancel that never fires.
 */
export function memoryRuntime(
  opts: {
    clock?: Runtime["clock"];
    matches?: Record<string, string[]>;
    files?: Record<string, string>;
  } = {},
): Runtime & {
  startTimer: ReturnType<typeof manualTimer>;
  fs: MemoryFileSystem;
  lockfile: MemoryLockfile;
} {
  const clock = opts.clock ?? steppingClock();
  const { fs, syncFs } = createMemoryWorkflowFileSystem(opts.files);
  return {
    exec: okExec,
    clock,
    startTimer: manualTimer(),
    fs,
    syncFs,
    lockfile: createMemoryLockfile(clock),
    fileMatcher: createMemoryFileMatcher(opts.matches),
    env: {},
    abortOnSignals: () => new AbortController().signal,
  };
}
