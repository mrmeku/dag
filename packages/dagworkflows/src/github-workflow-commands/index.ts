/*
 * GitHub's workflow-command grammar, written and read without `@actions/core`: the toolkit only
 * writes a command to stdout, while a task's `warn` needs the line for its node's log, and a local
 * process must not load the toolkit at startup.
 */

// `@actions/core` escapes its own workflow commands but does not export the escaping.
const escapeData = (s: string) =>
  s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s: string) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** A GitHub warning as a log line, which GitHub shows titled `title` when it prints the log. */
export const warningCommand = (title: string, message: string): string =>
  `::warning title=${escapeProperty(title)}::${escapeData(message)}`;

// .NET's TrimStart, which the runner uses, also strips U+0085.
const trimStart = (line: string) => line.replace(/^[\s\u0085]+/, "");

/**
 * What GitHub's runner reads in `lines`: their warnings, and the token of a `::stop-commands::`
 * they leave open. Like the runner, it ends a line at a carriage return too.
 */
function runnerReading(lines: string[]) {
  const warnings: ReturnType<typeof warningsOf> = [];
  let stopToken: string | undefined;
  for (const [line, text] of lines.entries())
    for (const segment of text.split("\r")) {
      const trimmed = trimStart(segment);
      const end = trimmed.startsWith("::") ? trimmed.indexOf("::", 2) : -1;
      if (end < 0) continue;
      const command = trimmed.slice(2, end).split(" ")[0]?.toLowerCase();
      const data = trimmed.slice(end + 2);
      if (stopToken !== undefined) {
        if (command === stopToken.toLowerCase()) stopToken = undefined;
      } else if (command === "stop-commands") stopToken = data;
      else if (command === "warning") {
        const message = data.replaceAll("%0D", "\r").replaceAll("%0A", "\n").replaceAll("%25", "%");
        warnings.push({ line, message });
      }
    }
  return { warnings, stopToken };
}

/**
 * Each `::warning` workflow command in `lines`, by its line's index, with its message, as GitHub's
 * runner reads one: after a carriage return or leading whitespace, in any case, unescaped, and
 * none while a `::stop-commands::` holds the commands off.
 */
export function warningsOf(lines: string[]): { line: number; message: string }[] {
  return runnerReading(lines).warnings;
}

/** A toolkit `::debug::` command (the globber writes one per file) is for GitHub's debug mode alone. */
export const isDebugCommand = (line: string): boolean => line.startsWith("::debug::");

/**
 * The token of a `::stop-commands::` the lines leave open. On GitHub one ends with its step, and
 * every node's log replays in this one step, so the group that opened it resumes it.
 */
export function openStopToken(lines: string[]): string | undefined {
  return runnerReading(lines).stopToken;
}

/**
 * GitHub does not nest log groups: a tool's own `::group::` inside a node's group would end the
 * node's group early. Its title stays as a plain line; `::endgroup::` goes.
 */
export function flattenGroups(lines: string[]): string[] {
  return lines.flatMap((line) =>
    line.startsWith("::endgroup::") ? [] : line.startsWith("::group::") ? [line.slice(9)] : [line],
  );
}
