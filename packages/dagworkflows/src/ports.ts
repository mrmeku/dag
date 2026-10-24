import type { context } from "@actions/github";
import type { DagFs } from "@mrmeku/dagraph";
import type * as properLockfile from "proper-lockfile";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Both streams as the command wrote them, in arrival order. */
  output: string;
  ok: boolean;
}

/**
 * Runs external commands, named after `@actions/exec`: an argv, with no shell unless the argv
 * starts one (`["sh", "-c", "..."]`). Never throws on a non-zero exit; the caller reads `code`.
 * `env` is merged over the inherited environment, and an `undefined` value removes a variable.
 * When `signal` fires the command is interrupted (SIGINT, then SIGTERM, then SIGKILL after the
 * grace periods in config.ts) and resolves with its exit status as usual. `onOutput` receives
 * `output` as it arrives, chunk by chunk. A program that cannot start resolves with code -1 and
 * `spawn <program> <error code>` as both `stderr` and `output`: `spawn bash ENOENT`.
 */
export interface Exec {
  run: (
    cmd: string[],
    opts?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      signal?: AbortSignal;
      onOutput?: (chunk: string) => void;
    },
  ) => Promise<ExecResult>;
}

export interface Clock {
  now: () => number;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Synchronous writes: three functions of `node:fs`, so that module is itself a SyncFs. The local
 * recorders write with them, so their files are whole when the process is forced out.
 */
export type SyncFs = Pick<
  typeof import("node:fs"),
  "mkdirSync" | "writeFileSync" | "appendFileSync"
>;

/**
 * Where `workflow.cache` keeps its paths between runs. `restore` puts `paths` back from the entry
 * under `key`, or the newest whose key starts with `key` or a `restoreKeys` prefix, and resolves to
 * what it restored from, or undefined on a miss. `save` keeps `paths` under `key` unless the store
 * has an entry for it already, and resolves to whether it saved. A `ValidationError` rejection,
 * for an invalid key or path, fails the task; any other is a warning.
 */
export interface CacheStore {
  restore: (paths: string[], key: string, restoreKeys: string[]) => Promise<string | undefined>;
  save: (paths: string[], key: string) => Promise<boolean>;
}

/** What an upload takes beside its files: the inputs of `actions/upload-artifact` the service reads. */
export interface ArtifactUploadOptions {
  /** Delete an artifact of the same name first: a re-run of a failed job shares its run's artifacts. */
  overwrite?: boolean;
  retentionDays?: number;
  compressionLevel?: number;
}

/**
 * Where `workflow.uploadArtifact` puts an artifact of the run. `upload` sends `files` as the
 * artifact `name`, each by its path from `rootDirectory`, and resolves to the artifact's id and
 * size, or undefined when there is no store to take it. It rejects a name the run has used
 * already, unless `overwrite` replaces that artifact.
 */
export interface ArtifactStore {
  upload: (
    name: string,
    files: string[],
    rootDirectory: string,
    options: ArtifactUploadOptions,
  ) => Promise<{ id: number; size: number } | undefined>;
}

export type AnnotationLevel = "error" | "warning" | "notice";

/**
 * What the runner knows about the event it is running for: the fields of `@actions/github`'s
 * `Context` a workflow reads, plus the two the toolkit has no notion of, since it never runs
 * anywhere but GitHub. Locally, git fills `ref` (`refs/heads/<branch>`, `""` on a detached HEAD),
 * `sha` and `actor`; the rest is `0` and `""`.
 */
export type CiContext = Pick<
  typeof context,
  "ref" | "sha" | "eventName" | "actor" | "runId" | "repo" | "serverUrl"
> & {
  isCi: boolean;
  provider: string;
};

export type CheckConclusion = "success" | "failure" | "skipped" | "cancelled" | "timed_out";

/** One node's live status, as a provider "check" (GitHub: a check run in the PR Checks tab). */
export interface CheckUpdate {
  name: string;
  status: "in_progress" | "completed";
  conclusion?: CheckConclusion;
  startedAt?: string;
  completedAt?: string;
  /** One line of status, e.g. "done in 1.2s". */
  summary?: string;
}

/**
 * What a node reports through to its host, local or GitHub: annotations, log groups, check runs
 * and the step summary. On GitHub this emits workflow commands (collapsible log groups, plain
 * lines, annotations), writes the step summary, and drives check runs; locally it prints to the
 * terminal, writes the summary to a file, and treats checks as a no-op. Everything host-specific
 * goes through here, so a workflow runs unchanged in both places.
 */
export interface Host {
  context: () => Promise<CiContext>;
  group: (title: string, lines: string[]) => void;
  info: (line: string) => void;
  annotate: (level: AnnotationLevel, title: string, message: string) => void;
  summary: (markdown: string) => Promise<void>;
  check: (update: CheckUpdate) => Promise<void>;
}

/** proper-lockfile: a run's lock on its history says the run is still going. */
export type Lockfile = Pick<typeof properLockfile, "lock" | "check">;

/** The context every step is bound to. */
export interface Ports {
  exec: Exec;
  fs: DagFs;
  clock: Clock;
  host: Host;
  cacheStore: CacheStore;
  artifactStore: ArtifactStore;
  lockfile: Lockfile;
  /**
   * The process's environment: `process.env` in the CLI and the action. Nothing in this package
   * reads it; createExec merges a command's `env` over `process.env` itself.
   */
  env: Readonly<NodeJS.ProcessEnv>;
}

/**
 * The ports a workflow and its tasks read, `workflow.ports` and an action's `ports`: every port
 * but `exec`. A command runs only inside a node, through its shell (`run` and `runShell`, or a
 * `cmd` or `shell` task), where its log, timeout and cancel apply; only the shell and the
 * adapters use `exec`.
 */
export type WorkflowPorts = Omit<Ports, "exec">;
