import { createMemoryDagFs, type MemoryDagFs } from "@mrmeku/dagraph";
import { dirname } from "node:path";
import type {
  AnnotationLevel,
  CheckUpdate,
  Ci,
  CiContext,
  Clock,
  Lockfile,
  Ports,
  Sh,
  SyncFs,
} from "../ports.ts";
import { createMemoryActionsArtifact, type MemoryActionsArtifact } from "./actions-artifact.ts";
import { createMemoryActionsCache, type MemoryActionsCache } from "./actions-cache.ts";

export interface RecordedCi {
  ci: Ci;
  /** The job log in order: a group as its title and lines, a plain line as itself. */
  log: Array<string | { title: string; lines: string[] }>;
  annotations: Array<{ level: AnnotationLevel; title: string; message: string }>;
  summaries: string[];
  checks: CheckUpdate[];
}

/** A Ci that records every call, so tests can assert the exact reporter output. */
export function createRecordingCi(context: Partial<CiContext> = {}): RecordedCi {
  const rec: RecordedCi = {
    log: [],
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
        runId: 0,
        repo: { owner: "", repo: "" },
        serverUrl: "",
        ...context,
      }),
      group: (title, lines) => void rec.log.push({ title, lines }),
      info: (line) => void rec.log.push(line),
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
export const okSh: Sh = {
  run: async () => ({ code: 0, stdout: "", stderr: "", output: "", ok: true }),
};

export type MemoryLockfile = Lockfile & { held: Set<string> };

/** Locks held in memory, by lock path, as proper-lockfile holds them on disk; a release frees one. */
export function createMemoryLockfile(): MemoryLockfile {
  const held = new Set<string>();
  const at = (file: string, opts?: { lockfilePath?: string | undefined }) =>
    opts?.lockfilePath ?? `${file}.lock`;
  return {
    held,
    lock: async (file, opts) => {
      const path = at(file, opts);
      if (held.has(path))
        throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED" });
      held.add(path);
      return async () => void held.delete(path);
    },
    check: async (file, opts) => held.has(at(file, opts)),
  };
}

/** Ports built from doubles: the one fixture every dagactions test starts from. */
export function createTestPorts(
  opts: {
    files?: Record<string, string>;
    sh?: Sh;
    clock?: Clock;
    actionsCache?: MemoryActionsCache;
    actionsArtifact?: MemoryActionsArtifact;
    context?: Partial<CiContext>;
    env?: Record<string, string | undefined>;
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
      lockfile: createMemoryLockfile(),
      env: opts.env ?? {},
    },
    fs,
    rec,
    actionsCache,
    actionsArtifact,
  };
}

/**
 * Synchronous writes in memory: `files` holds each file's text by path. As with node:fs, a file's
 * directory must be made before the file is written.
 */
export function createMemorySyncFs(): SyncFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const directories = new Set([".", "/"]);
  const writablePath = (path: unknown) => {
    const file = String(path);
    if (!directories.has(dirname(file)))
      throw new Error(`ENOENT: no such file or directory, '${file}'`);
    return file;
  };
  return {
    files,
    mkdirSync: (path: unknown) => {
      for (
        let directory = String(path);
        !directories.has(directory);
        directory = dirname(directory)
      )
        directories.add(directory);
      return undefined;
    },
    writeFileSync: (path, data) => void files.set(writablePath(path), String(data)),
    appendFileSync: (path, data) => {
      const file = writablePath(path);
      files.set(file, (files.get(file) ?? "") + String(data));
    },
  };
}
