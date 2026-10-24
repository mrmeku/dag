import { createMemoryDagFs, type MemoryDagFs } from "@mrmeku/dagraph";
import { dirname } from "node:path";
import type {
  AnnotationLevel,
  CheckUpdate,
  CiContext,
  Clock,
  Exec,
  Host,
  Lockfile,
  Ports,
  SyncFs,
} from "../ports.ts";
import { createMemoryArtifactStore, type MemoryArtifactStore } from "./artifact-store.ts";
import { createMemoryCacheStore, type MemoryCacheStore } from "./cache-store.ts";

export interface RecordedHost {
  host: Host;
  /** The job log in order: a group as its title and lines, a plain line as itself. */
  log: Array<string | { title: string; lines: string[] }>;
  annotations: Array<{ level: AnnotationLevel; title: string; message: string }>;
  summaries: string[];
  checks: CheckUpdate[];
}

/** A Host that records every call, so tests can assert the exact reporter output. */
export function createRecordingHost(context: Partial<CiContext> = {}): RecordedHost {
  const rec: RecordedHost = {
    log: [],
    annotations: [],
    summaries: [],
    checks: [],
    host: {
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

/** A clock that reads its time from `now` and whose sleep ends at once: `clockAt(() => now)`. */
export function clockAt(now: () => number = () => 0): Clock {
  return { now, sleep: async () => {} };
}

/** Deterministic clock: each call advances by `step`, and a sleep ends at once. */
export function steppingClock(start = 0, step = 1000): Clock {
  let t = start - step;
  return clockAt(() => (t += step));
}

/** An Exec where every command succeeds silently. */
export const okExec: Exec = {
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

/** Ports built from doubles: the one fixture every dagworkflows test starts from. */
export function createTestPorts(
  opts: Partial<Pick<Ports, "exec" | "clock" | "env">> & {
    files?: Record<string, string>;
    cacheStore?: MemoryCacheStore;
    artifactStore?: MemoryArtifactStore;
    context?: Partial<CiContext>;
  } = {},
): {
  ports: Ports;
  fs: MemoryDagFs;
  rec: RecordedHost;
  cacheStore: MemoryCacheStore;
  artifactStore: MemoryArtifactStore;
} {
  const fs = createMemoryDagFs(opts.files);
  const rec = createRecordingHost(opts.context);
  const cacheStore = opts.cacheStore ?? createMemoryCacheStore();
  const artifactStore = opts.artifactStore ?? createMemoryArtifactStore();
  return {
    ports: {
      exec: opts.exec ?? okExec,
      fs,
      clock: opts.clock ?? steppingClock(),
      host: rec.host,
      cacheStore,
      artifactStore,
      lockfile: createMemoryLockfile(),
      env: opts.env ?? {},
    },
    fs,
    rec,
    cacheStore,
    artifactStore,
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
  const text = (data: string | NodeJS.ArrayBufferView) =>
    typeof data === "string" ? data : new TextDecoder().decode(data);
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
    writeFileSync: (path, data) => void files.set(writablePath(path), text(data)),
    appendFileSync: (path, data) => {
      const file = writablePath(path);
      files.set(file, (files.get(file) ?? "") + text(data));
    },
  };
}
