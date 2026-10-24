import type { Result } from "@mrmeku/dagraph";

/** Local CAS directory, relative to the repo root. Carried between runs by actions/cache nodes in the workflow. */
export const DEFAULT_CAS_DIR = ".dag/cas";
/** Each run writes its history, its settled nodes, here as they settle; `dag post` reads them. */
export const DEFAULT_HISTORY_DIR = ".dag/history";
/**
 * A run holds a lock beside its history and refreshes it while it runs. A lock this old belongs to
 * a run killed outright, whose posts a later run may then settle; proper-lockfile's default.
 */
export const HISTORY_LOCK_STALE_MS = 10_000;
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
/**
 * A post's backoff, unless it sets `retry: "once"`: after a failed try it runs again after each
 * delay in turn, so three tries in all, inside its own `timeoutMs`.
 */
export const POST_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000];
/** Where the local adapter writes the markdown summary GitHub would render on the run page. */
export const DEFAULT_SUMMARY_PATH = ".dag/summary.md";
/** Each node's output as it arrives, in `<dir>/<node>.log`. */
export const DEFAULT_LOG_DIR = ".dag/logs";
/** The last local run's failures, for a person or an agent to fix from. */
export const DEFAULT_FAILURES_REPORT_PATH = ".dag/failures.md";
/** What reruns a workflow file, followed by the file: every rerun and reproduce line starts so. */
export const RERUN_COMMAND = "npx --no dag run";
/**
 * The local terminal's output: `live` keeps a footer of running nodes under the scrollback,
 * `failures` prints only failures and the recap (an agent's), and `grouped` every node's log as
 * GitHub groups it (pipes and CI).
 */
export const OUTPUT_STYLES = ["live", "failures", "grouped"] as const;
export type OutputStyle = (typeof OUTPUT_STYLES)[number];
/** Overrides the style the CLI picks; `--output-style` overrides this. */
export const OUTPUT_STYLE_ENV = "DAG_OUTPUT_STYLE";
/** A failure's log in the terminal: whole up to FAILURE_FULL_LINES lines, else its last FAILURE_TAIL_LINES. */
export const FAILURE_FULL_LINES = 40;
export const FAILURE_TAIL_LINES = 20;
/**
 * The `failures` style keeps its whole output within what an agent's tool shows of a command
 * (~10,000 characters): the first AGENT_FAILURE_BLOCKS failures as blocks whose tails share
 * AGENT_TAIL_BUDGET_CHARS, later ones a line each, and lines past AGENT_OUTPUT_BUDGET_CHARS
 * counted, not printed. The recap always prints.
 */
export const AGENT_FAILURE_BLOCKS = 3;
export const AGENT_TAIL_BUDGET_CHARS = 4000;
export const AGENT_OUTPUT_BUDGET_CHARS = 7000;
/** The recap names this many of the nodes a failure brought down, then counts the rest. */
export const RECAP_NAMES_SHOWN = 5;
/** A longer line of a command's output is cut in the terminal; the log file keeps it whole. */
export const SCROLLBACK_LINE_MAX_CHARS = 500;
/** Names pad to the longest in the run, up to this many columns; only the footer cuts one. */
export const NAME_MAX_COLUMNS = 24;
/** Where a labelled value starts: a failure block's `├ log    …`, the recap's `logs     …`. */
export const LABEL_COLUMNS = 9;
/** The footer redraws this often once the run is LIVE_FIRST_DRAW_MS old: a cached run shows none. */
export const LIVE_FRAME_MS = 100;
export const LIVE_FIRST_DRAW_MS = 500;
/** The footer's largest size (and at most half the rows), so a narrower window rarely reflows it. */
export const LIVE_MAX_ROWS = 8;
export const LIVE_MAX_COLUMNS = 72;
export const LIVE_MIN_COLUMNS = 10;
/** The terminal's size when stdout does not say it, as when `live` is asked for in a pipe. */
export const LIVE_FALLBACK_SIZE = { columns: 80, rows: 24 };
/** A command's latest line is cut to this many characters before anything measures its width. */
export const LIVE_LATEST_LINE_MAX_CHARS = 2 * LIVE_MAX_COLUMNS;
/** A row's latest line follows its clock after this many spaces, given LIVE_LATEST_LINE_MIN_COLUMNS columns. */
export const LIVE_LATEST_LINE_GAP = 2;
export const LIVE_LATEST_LINE_MIN_COLUMNS = 4;
/** The waiting nodes the footer lists, with the deps they wait on, LIVE_WAITS_ON_SHOWN named. */
export const LIVE_WAITING_ROWS = 2;
export const LIVE_WAITS_ON_SHOWN = 2;
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Directories `workflow.glob` leaves out. Leave out others with a negation: `!dist/**`. */
export const DEFAULT_EXCLUDES = [".git", "node_modules", ".dag"];
/** GitHub refuses a check run whose summary is over 65,535 characters; the tail that fits is kept. */
export const CHECK_TEXT_MAX_CHARS = 65_000;
/** Above this many nodes the summary draws one node per kind instead (GitHub refuses huge diagrams). */
export const MAX_GRAPH_NODES = 60;
/** Trailing log lines shown inside a failed node's collapsible block in the summary. */
export const FAILURES_REPORT_LOG_LINES = 60;
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
export const STATUS_ICON: Record<Result["status"], string> = {
  done: "✔\uFE0E",
  cached: "✔\uFE0E",
  failed: "✖\uFE0E",
  "dep-failed": "⏭\uFE0E",
  cancelled: "◼\uFE0E",
};
