/*
 * What a step leaves for the outputs that draw a run: its log beside the CAS, the warnings it
 * writes there as `warningLine`s, and the cause a node's error carries when a command it ran
 * failed. A leaf, so the run store reads them without the step vocabulary.
 */
import type { DagFs } from "@mrmeku/dagraph";
import { basename, dirname } from "node:path";
import type { ExecResult } from "./ports.ts";

/**
 * Where a step stores its log, stdout and stderr as they arrived, for the reporter: beside the
 * CAS, never in it, since the CAS goes into a cache any pull request can restore and nothing
 * masks what a command printed. Keyed by the action key, so a cached node shows the log of the
 * run that built it: the CAS `/cas` keeps the log of key `k` in `/cas.logs/k.log`.
 */
export const logPath = (casBaseDir: string, actionKey: string): string =>
  `${casBaseDir}.logs/${actionKey}.log`;

/** The log beside `outputDir`, which the engine makes in `{cas}/{key}/`. */
export const logOf = (outputDir: string): string => {
  const keyDir = dirname(outputDir);
  return logPath(dirname(keyDir), basename(keyDir));
};

/** Renamed into place, so a reader never sees half a log. */
export async function writeLog(fs: DagFs, outputDir: string, log: string): Promise<void> {
  const path = logOf(outputDir);
  const written = `${path}.${basename(outputDir)}`;
  await fs.writeText(written, log);
  await fs.rename(written, path);
}

// `@actions/core` escapes its own workflow commands but does not export the escaping.
const escapeData = (s: string) =>
  s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** A GitHub warning as a log line, which GitHub shows titled `title` when it prints the log. */
export const warningLine = (title: string, message: string): string =>
  `::warning title=${escapeProperty(title)}::${escapeData(message)}`;

/** What a node's error carries as its `cause` when a command it ran failed: the command, where, and how it ended. */
export interface CommandCause extends Pick<ExecResult, "ended" | "code"> {
  argv: string[];
  cwd: string;
}

const ENDINGS: readonly unknown[] = [
  "exited",
  "signalled",
  "not-started",
] satisfies ExecResult["ended"][];

const isCommandCause = (cause: unknown): cause is CommandCause =>
  typeof cause === "object" &&
  cause !== null &&
  "argv" in cause &&
  Array.isArray(cause.argv) &&
  cause.argv.every((arg) => typeof arg === "string") &&
  "cwd" in cause &&
  typeof cause.cwd === "string" &&
  "code" in cause &&
  typeof cause.code === "number" &&
  "ended" in cause &&
  ENDINGS.includes(cause.ended);

/** The command whose failure failed the node; a node that failed otherwise may carry any cause, or none. */
export function commandOf(error: { cause?: unknown }): CommandCause | undefined {
  return isCommandCause(error.cause) ? error.cause : undefined;
}
