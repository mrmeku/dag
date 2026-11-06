import { errorMessage } from "@mrmeku/dagraph";
import { SUMMARY_BUDGET_BYTES } from "../config/index.ts";

/** Renders one block of the step summary from a report, as markdown lines. [] renders nothing. */
export type SummaryRenderer<Report> = (report: Report) => string[] | Promise<string[]>;

const longestBacktickRun = (text: string): number =>
  (text.match(/`+/g) ?? []).reduce(
    (longest, backtickRun) => Math.max(longest, backtickRun.length),
    0,
  );

/**
 * `lines` as a fenced log, its fence longer than any backtick run inside, so no line of the log
 * ends it: the block that goes first when the summary is over its budget.
 */
export function logBlock(lines: string[]): string[] {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(lines.join("\n")) + 1));
  return [`${fence}text`, ...lines, fence];
}

/** A log block: from its fence and `text` to the same fence alone on a line. */
const LOG_BLOCK = /^(`{3,})text\n[\s\S]*?^\1$/gm;

const OVER_BUDGET = "summary over the 1 MiB budget";

/**
 * The step summary: `## title`, then each renderer's block that is not empty, a blank line apart,
 * and the renderers that threw, each by its function name or `#<place>`. A renderer that throws
 * leaves a note in its place. Over the budget, every log block is dropped, then each block that no
 * longer fits beside a note in place of every block after it, so the renderers listed first keep
 * their room.
 */
export async function stepSummary<Report>(
  title: string,
  renderers: readonly SummaryRenderer<Report>[],
  report: Report,
): Promise<{ markdown: string; failed: { name: string; message: string }[] }> {
  const parts: Array<[name: string, text: string]> = [];
  const failed: { name: string; message: string }[] = [];
  for (const [i, render] of renderers.entries()) {
    const name = render.name || `#${i + 1}`;
    try {
      const lines = await render(report);
      if (lines.length > 0) parts.push([name, lines.join("\n")]);
    } catch (e) {
      const message = errorMessage(e);
      failed.push({ name, message });
      parts.push([name, `_(${name} failed: ${message})_`]);
    }
  }
  if (parts.length === 0) return { markdown: "", failed };
  const all: Array<[string, string]> = [["heading", `## ${title}`], ...parts];
  const size = (text: string) => Buffer.byteLength(text) + 2;
  let texts = all.map(([, text]) => text);
  if (texts.reduce((total, text) => total + size(text), 0) > SUMMARY_BUDGET_BYTES) {
    const omitted = (name: string) => `_(${name} omitted: ${OVER_BUDGET})_`;
    let left = all.reduce((total, [name]) => total - size(omitted(name)), SUMMARY_BUDGET_BYTES);
    texts = all.map(([name, text]) => {
      const trimmed = text.replace(LOG_BLOCK, `_(log omitted: ${OVER_BUDGET})_`);
      const extra = size(trimmed) - size(omitted(name));
      if (extra > left) return omitted(name);
      left -= extra;
      return trimmed;
    });
  }
  return { markdown: texts.join("\n\n") + "\n", failed };
}
