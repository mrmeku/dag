import type { ExecResult } from "@mrmeku/dagraph";

/** Local CAS directory, relative to the repo root. Carried between runs by actions/cache nodes in the workflow. */
export const DEFAULT_CAS_DIR = ".dagactions/cas";
/** Every settled node of the last run, written as nodes settle; `dagactions post` reads it. */
export const DEFAULT_JOURNAL_PATH = ".dagactions/journal.json";
/**
 * A cancelled command gets SIGINT, then SIGTERM, then SIGKILL, this long apart. GitHub's runner
 * sends the step SIGTERM 7500 ms after its own SIGINT, so the sum must leave the main step time
 * to settle and write its summary inside that window.
 */
export const CHILD_SIGINT_GRACE_MS = 2000;
export const CHILD_SIGTERM_GRACE_MS = 1000;
/**
 * After a command exits, how long a process it left behind may hold its output open before the
 * command settles without it. GitHub's runner waits 5 s; this stays inside the window above.
 */
export const STREAM_DRAIN_GRACE_MS = 1000;
/** Where the local adapter writes the markdown summary GitHub would render on the run page. */
export const DEFAULT_SUMMARY_PATH = ".dagactions/summary.md";
/** Directory names pruned from source hashing. Must include the CAS itself. */
export const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  ".dagactions",
  ".work",
  "output",
  "var",
  "logs",
  "target",
  "coverage",
  "dist",
];
/** GitHub refuses a check run whose summary is over 65,535 characters; the tail that fits is kept. */
export const CHECK_TEXT_MAX_CHARS = 65_000;
/** Above this many nodes the summary draws one node per kind instead (GitHub refuses huge diagrams). */
export const MAX_GRAPH_NODES = 60;
/** Trailing log lines shown inside a failed node's collapsible block in the summary. */
export const FAILURE_LOG_LINES = 60;
/** GitHub caps a step summary at 1 MiB; the summary stays within this many UTF-8 bytes, leaving room for the rest of the step. */
export const SUMMARY_BUDGET_BYTES = 900_000;
/** A node shorter than this is left out of the critical path; none as long hides the line. */
export const CRITICAL_PATH_FLOOR_MS = 1000;
/** Node durations from the previous run, kept beside the CAS so main's cache entry carries it. */
export const LAST_RUN_FILE = "last-run.json";
/**
 * A node's status as an icon, in log group titles, the summary and the DAG's labels: Nx's
 * terminal set (figures' tick and cross; its TUI's skipped and stopped), where a cache hit is a
 * success and the word "cached" says the rest. U+FE0E keeps a browser from drawing an emoji.
 */
export const STATUS_ICON: Record<ExecResult["status"], string> = {
  done: "✔\uFE0E",
  cached: "✔\uFE0E",
  fail: "✖\uFE0E",
  "dep-failed": "⏭\uFE0E",
  cancelled: "◼\uFE0E",
};
/**
 * What the action's own process holds and a GitHub `run:` step never gets: GitHub's token and the
 * runner's runtime token, which the runner masks, and the runner's service endpoints. Commands
 * never inherit them.
 */
export const RUNNER_TOKENS = ["GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN"] as const;
export const RUNNER_ENDPOINTS = [
  "ACTIONS_RUNTIME_URL",
  "ACTIONS_CACHE_URL",
  "ACTIONS_RESULTS_URL",
] as const;
/** The action's inputs, which a `run:` step never sees: commands never inherit them. */
export const ACTION_INPUT_ENV = /^INPUT_/;
