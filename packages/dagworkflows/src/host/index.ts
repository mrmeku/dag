import type { context } from "@actions/github";

export type AnnotationLevel = "error" | "warning" | "notice";

/**
 * What the runner knows about the event it is running for: the fields of `@actions/github`'s
 * `Context` a workflow reads, plus the two the toolkit has no notion of, since it never runs
 * anywhere but GitHub.
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
 * What a run asks of the place it runs: its context, annotations, log groups, check runs and the
 * step summary. A `Platform`'s narrow member: its display and stores are the platform's others.
 */
export interface Host {
  context: () => Promise<CiContext>;
  group: (title: string, lines: string[]) => void;
  info: (line: string) => void;
  annotate: (level: AnnotationLevel, title: string, message: string) => void;
  summary: (markdown: string) => Promise<void>;
  check: (update: CheckUpdate) => Promise<void>;
}

/** A Host that does nothing, for a program that only wants the results. */
export function nullHost(): Host {
  return {
    context: async () => ({
      isCi: false,
      provider: "none",
      ref: "",
      sha: "",
      eventName: "",
      actor: "",
      runId: 0,
      repo: { owner: "", repo: "" },
      serverUrl: "",
    }),
    group: () => {},
    info: () => {},
    annotate: () => {},
    summary: async () => {},
    check: async () => {},
  };
}
