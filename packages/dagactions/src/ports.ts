import type { ArtifactClient } from "@actions/artifact";
import type * as cache from "@actions/cache";
import type { context } from "@actions/github";
import type { DagFs } from "@mrmeku/dagraph";

export interface ShResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Both streams as the command wrote them, in arrival order. */
  output: string;
  ok: boolean;
}

/**
 * Runs external commands. Never throws on a non-zero exit; the caller reads `code`. `env` is
 * merged over the inherited environment, and an `undefined` value removes a variable. When
 * `signal` fires the command is interrupted (SIGINT, then SIGTERM, then SIGKILL after the
 * grace periods in config.ts) and resolves with its exit status as usual.
 */
export interface Sh {
  run: (
    cmd: string[],
    opts?: { cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal },
  ) => Promise<ShResult>;
}

export interface Clock {
  now: () => number;
}

/**
 * The cache service behind `actions/cache`: the two functions of `@actions/cache`, so that
 * module is itself an ActionsCache and so is any client with the same two. `restoreCache`
 * resolves to the key it restored, or undefined on a miss; `saveCache` to the new entry's id.
 */
export type ActionsCache = Pick<typeof cache, "restoreCache" | "saveCache">;

/**
 * The artifact service behind `actions/upload-artifact`: two methods of `@actions/artifact`'s
 * client, so a `DefaultArtifactClient` is itself an ActionsArtifact. `uploadArtifact` zips the
 * files with their paths relative to the root directory and resolves to the new artifact's id,
 * size and digest; `deleteArtifact` rejects with an `ArtifactNotFoundError` for an unknown name.
 */
export type ActionsArtifact = Pick<ArtifactClient, "uploadArtifact" | "deleteArtifact">;

export type AnnotationLevel = "error" | "warning" | "notice";

/**
 * What the runner knows about the event it is running for: the fields of `@actions/github`'s
 * `Context` a workflow reads, plus the two the toolkit has no notion of, since it never runs
 * anywhere but GitHub. Locally, git fills `ref`, `sha` and `actor`; the rest is `0` and `""`.
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
 * The CI-provider surface. On GitHub this emits workflow commands (collapsible log groups, plain
 * lines, annotations), writes the step summary, and drives check runs; locally it prints to the
 * terminal, writes the summary to a file, and treats checks as a no-op. Everything
 * provider-specific goes through here, so a workflow runs unchanged in both places.
 */
export interface Ci {
  context: () => Promise<CiContext>;
  group: (title: string, lines: string[]) => void;
  info: (line: string) => void;
  annotate: (level: AnnotationLevel, title: string, message: string) => void;
  summary: (markdown: string) => Promise<void>;
  check: (update: CheckUpdate) => Promise<void>;
}

/** The context every step is bound to. */
export interface Ports {
  sh: Sh;
  fs: DagFs;
  clock: Clock;
  ci: Ci;
  actionsCache: ActionsCache;
  actionsArtifact: ActionsArtifact;
  /**
   * The environment `sh` hands its commands, which `w.secrets` reads and the run step withholds
   * from: `process.env` with createSh.
   */
  env: Readonly<Record<string, string | undefined>>;
}
