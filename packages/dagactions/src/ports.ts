import type { ArtifactClient } from "@actions/artifact";
import type * as cache from "@actions/cache";
import type { DagFs } from "@mrmeku/dagraph";

export interface ShResult {
  code: number;
  stdout: string;
  stderr: string;
  ok: boolean;
}

/**
 * Runs external commands. Never throws on a non-zero exit; the caller reads `code`. When
 * `signal` fires the command is interrupted (SIGINT, then SIGTERM, then SIGKILL after the
 * grace periods in config.ts) and resolves with its exit status as usual.
 */
export interface Sh {
  run: (
    cmd: string[],
    opts?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
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

/** What the runner knows about the event it is running for. */
export interface CiContext {
  isCi: boolean;
  provider: string;
  ref: string;
  sha: string;
  eventName: string;
  actor: string;
}

export type CheckConclusion = "success" | "failure" | "skipped" | "cancelled";

/** One node's live status, as a provider "check" (GitHub: a check run in the PR Checks tab). */
export interface CheckUpdate {
  name: string;
  status: "in_progress" | "completed";
  conclusion?: CheckConclusion;
  startedAt?: string;
  completedAt?: string;
  /** One line of status, e.g. "done in 1.2s". */
  summary?: string;
  /** Markdown body for the check's own page: the node's log. */
  details?: string;
}

/**
 * The CI-provider surface. On GitHub this emits workflow commands (collapsible log groups,
 * annotations), writes the step summary, and drives check runs; locally it prints to the
 * terminal, writes the summary to a file, and treats checks as a no-op. Everything
 * provider-specific goes through here, so a workflow runs unchanged in both places.
 */
export interface Ci {
  context: () => Promise<CiContext>;
  group: (title: string, lines: string[]) => void;
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
}
