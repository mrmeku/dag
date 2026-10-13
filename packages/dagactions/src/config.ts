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
/** Trailing log lines put on a node's check-run page (GitHub shows them under the check). */
export const CHECK_TEXT_LINES = 200;
/** Above this many nodes the summary draws one node per kind instead (GitHub refuses huge diagrams). */
export const MAX_GRAPH_NODES = 60;
/** Trailing log lines shown inside a failed node's collapsible block in the summary. */
export const FAILURE_LOG_LINES = 60;
/** GitHub caps a step summary at 1 MiB; stay under it with room for the rest of the step. */
export const SUMMARY_BUDGET_BYTES = 900_000;
/** Node durations from the previous run, kept beside the CAS so main's cache entry carries it. */
export const LAST_RUN_FILE = "last-run.json";
