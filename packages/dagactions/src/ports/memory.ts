import { createMemoryDagFs, type MemoryDagFs } from "@mrmeku/dagraph";
import type { AnnotationLevel, CheckUpdate, Ci, CiContext, Clock, Ports, Sh } from "../ports.ts";
import { createMemoryActionsArtifact, type MemoryActionsArtifact } from "./actions-artifact.ts";
import { createMemoryActionsCache, type MemoryActionsCache } from "./actions-cache.ts";

export interface RecordedCi {
  ci: Ci;
  groups: Array<{ title: string; lines: string[] }>;
  annotations: Array<{ level: AnnotationLevel; title: string; message: string }>;
  summaries: string[];
  checks: CheckUpdate[];
}

/** A Ci that records every call, so tests can assert the exact reporter output. */
export function createRecordingCi(context: Partial<CiContext> = {}): RecordedCi {
  const rec: RecordedCi = {
    groups: [],
    annotations: [],
    summaries: [],
    checks: [],
    ci: {
      context: async () => ({
        isCi: false,
        provider: "recording",
        ref: "",
        sha: "",
        eventName: "",
        actor: "",
        ...context,
      }),
      group: (title, lines) => void rec.groups.push({ title, lines }),
      annotate: (level, title, message) => void rec.annotations.push({ level, title, message }),
      summary: async (markdown) => void rec.summaries.push(markdown),
      check: async (update) => void rec.checks.push(update),
    },
  };
  return rec;
}

/** Deterministic clock: each call advances by `step`. */
export function steppingClock(start = 0, step = 1000): Clock {
  let t = start - step;
  return { now: () => (t += step) };
}

/** A shell where every command succeeds silently. */
export const okSh: Sh = { run: async () => ({ code: 0, stdout: "", stderr: "", ok: true }) };

/** Ports built from doubles: the one fixture every dagactions test starts from. */
export function createTestPorts(
  opts: {
    files?: Record<string, string>;
    sh?: Sh;
    clock?: Clock;
    actionsCache?: MemoryActionsCache;
    actionsArtifact?: MemoryActionsArtifact;
    context?: Partial<CiContext>;
  } = {},
): {
  ports: Ports;
  fs: MemoryDagFs;
  rec: RecordedCi;
  actionsCache: MemoryActionsCache;
  actionsArtifact: MemoryActionsArtifact;
} {
  const fs = createMemoryDagFs(opts.files);
  const rec = createRecordingCi(opts.context);
  const actionsCache = opts.actionsCache ?? createMemoryActionsCache();
  const actionsArtifact = opts.actionsArtifact ?? createMemoryActionsArtifact();
  return {
    ports: {
      sh: opts.sh ?? okSh,
      fs,
      clock: opts.clock ?? steppingClock(),
      ci: rec.ci,
      actionsCache,
      actionsArtifact,
    },
    fs,
    rec,
    actionsCache,
    actionsArtifact,
  };
}
