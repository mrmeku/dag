/*
 * What a step leaves for the outputs that draw a run: its log beside the CAS, and the cause a
 * run step's failure carries. A leaf, so the run store reads them without the step vocabulary.
 */

/**
 * Where a step stores its log, stdout and stderr as they arrived, for the reporter: beside the
 * CAS, never in it, since the CAS goes into a cache any pull request can restore and nothing
 * masks what a command printed. `/cas/<key>/out` keeps it in `/cas.logs/<key>.log`.
 */
export const logPath = (outputDir: string): string =>
  outputDir.replace(/\/([^/]+)\/out$/, ".logs/$1.log");

/** What a run step's error carries as its `cause`: the command it ran, where, and how it exited. */
export interface CommandCause {
  argv: string[];
  cwd: string;
  code: number;
}

/** The command a run step's error names; another step's error may carry any cause, or none. */
export function commandOf(e: unknown): CommandCause | undefined {
  const cause = e instanceof Error ? (e.cause as Partial<CommandCause> | undefined) : undefined;
  return Array.isArray(cause?.argv) &&
    typeof cause.cwd === "string" &&
    typeof cause.code === "number"
    ? (cause as CommandCause)
    : undefined;
}
