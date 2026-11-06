import type { MemoryFileSystem } from "@mrmeku/dagraph";
import type { CiContext } from "../host/index.ts";
import { memoryRuntime } from "../memory/index.ts";
import {
  createMemoryArtifactStore,
  createMemoryCacheStore,
  createRecordingHost,
  type MemoryArtifactStore,
  type MemoryCacheStore,
  type RecordedHost,
} from "../recording/index.ts";
import type { Ports, WorkflowFileSystem } from "../workflow/index.ts";

export { clockAt, manualTimer, okExec, steppingClock } from "../memory/index.ts";

/**
 * Ports built from doubles, the one fixture every test of a workflow starts from: a fresh memory
 * runtime's members, the recording host and memory stores, each replaced when given.
 */
export function createTestPorts(
  opts: Partial<Pick<Ports, "exec" | "clock" | "env">> & {
    files?: Record<string, string>;
    matches?: Record<string, string[]>;
    cacheStore?: MemoryCacheStore;
    artifactStore?: MemoryArtifactStore;
    context?: Partial<CiContext>;
  } = {},
): {
  ports: Ports;
  fs: MemoryFileSystem & WorkflowFileSystem;
  rec: RecordedHost;
  cacheStore: MemoryCacheStore;
  artifactStore: MemoryArtifactStore;
} {
  const runtime = memoryRuntime({
    ...(opts.clock && { clock: opts.clock }),
    ...(opts.matches && { matches: opts.matches }),
    ...(opts.files && { files: opts.files }),
  });
  const rec = createRecordingHost(opts.context);
  const cacheStore = opts.cacheStore ?? createMemoryCacheStore();
  const artifactStore = opts.artifactStore ?? createMemoryArtifactStore();
  return {
    ports: {
      exec: opts.exec ?? runtime.exec,
      fs: runtime.fs,
      clock: runtime.clock,
      startTimer: runtime.startTimer,
      host: rec.host,
      cacheStore,
      artifactStore,
      lockfile: runtime.lockfile,
      fileMatcher: runtime.fileMatcher,
      env: opts.env ?? runtime.env,
    },
    fs: runtime.fs,
    rec,
    cacheStore,
    artifactStore,
  };
}
