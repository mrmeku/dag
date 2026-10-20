/*
 * What a step leaves for the outputs that draw a run: its log beside the CAS, and the cause a
 * run step's failure carries. A leaf, so the run store reads them without the step vocabulary.
 */

/**
 * Where a step stores its log, stdout and stderr as they arrived, for the reporter: beside the
 * CAS, never in it, since the CAS goes into a cache any pull request can restore and nothing
 * masks what a command printed. Keyed by the action key, so a cached node shows the log of the
 * run that built it: the CAS `/cas` keeps the log of key `k` in `/cas.logs/k.log`.
 */
export const logPath = (casBaseDir: string, actionKey: string): string =>
  `${casBaseDir}.logs/${actionKey}.log`;

/** What a run step's error carries as its `cause`: the command it ran, where, and how it exited. */
export interface CommandCause {
  argv: string[];
  cwd: string;
  code: number;
}

/** The command a run step's failure names; another step's may carry any cause, or none. */
export function commandOf(error: { cause?: unknown }): CommandCause | undefined {
  const cause = error.cause as Partial<CommandCause> | undefined;
  return Array.isArray(cause?.argv) &&
    typeof cause.cwd === "string" &&
    typeof cause.code === "number"
    ? (cause as CommandCause)
    : undefined;
}
