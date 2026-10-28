import {
  AGENT_FAILURE_BLOCKS,
  AGENT_OUTPUT_BUDGET_CHARS,
  AGENT_TAIL_BUDGET_CHARS,
  AGENT_WARNING_BUDGET_CHARS,
  AGENT_WARNINGS_SHOWN,
} from "../../config.ts";
import { plural, textOf } from "../../kernel/format.ts";
import type { RunListener } from "../../kernel/store.ts";
import { warningLines, warningsOf, type LocalContext } from "../words.ts";
import {
  blockLog,
  characterCountOf,
  failureBlockLines,
  failureLine,
  interruptedLines,
  passLines,
  recapLines,
  tailLines,
} from "./blocks.ts";

/** A writer of lines while they fit in `budgetChars`, which counts the lines past it. */
function budgetedWriter(budgetChars: number, writeText: (text: string) => void) {
  let budgetLeft = budgetChars;
  let linesLeftOut = 0;
  return {
    printLines: (lines: string[]) => {
      const printed: string[] = [];
      for (const line of lines) {
        if (linesLeftOut > 0 || line.length + 1 > budgetLeft) linesLeftOut++;
        else {
          printed.push(line);
          budgetLeft -= line.length + 1;
        }
      }
      if (printed.length > 0) writeText(textOf(printed));
    },
    linesLeftOut: () => linesLeftOut,
  };
}

/**
 * The `failures` style, an agent's: append-only, failures and warnings alone, within the
 * budgets in config.ts. Warnings have a budget of their own, so they never push a failure out.
 * Lines past a budget are counted, and the recap says where all of it is.
 */
export function createAgentRenderer(localContext: LocalContext, writeText: (text: string) => void) {
  const output = budgetedWriter(AGENT_OUTPUT_BUDGET_CHARS, writeText);
  const warningOutput = budgetedWriter(AGENT_WARNING_BUDGET_CHARS, writeText);
  const printLines = output.printLines;
  let tailBudgetLeft = AGENT_TAIL_BUDGET_CHARS;
  let failureBlocksPrinted = 0;
  /** A node's first warnings, then how many more and where. */
  const warningLinesOf = (name: string, log: string[]) => {
    const warnings = warningsOf(log);
    const shown = warningLines(name, warnings.slice(0, AGENT_WARNINGS_SHOWN));
    const moreCount = warnings.length - AGENT_WARNINGS_SHOWN;
    const where = localContext.logFile(name) ?? `${localContext.logDir}/`;
    return moreCount > 0 ? [...shown, `${plural(moreCount, "more warning")} in ${where}`] : shown;
  };

  return {
    begin: (pass, _run, isFirstPass) =>
      printLines(
        passLines(
          pass,
          localContext,
          isFirstPass ? `report ${localContext.failuresReportPath}` : undefined,
        ),
      ),
    settle: (nodeState, run, log) => {
      if (nodeState.status === "failed") {
        if (failureBlocksPrinted === AGENT_FAILURE_BLOCKS)
          printLines([failureLine(nodeState, 0, localContext)]);
        else {
          failureBlocksPrinted++;
          const tail = tailLines(blockLog(nodeState), tailBudgetLeft);
          tailBudgetLeft -= characterCountOf(tail);
          printLines(failureBlockLines(nodeState, run, localContext, tail));
        }
      }
      warningOutput.printLines(warningLinesOf(nodeState.node.name, log));
    },
    close: (run) =>
      writeText(
        textOf([
          ...recapLines(run, localContext, { failuresShown: AGENT_FAILURE_BLOCKS }),
          ...(output.linesLeftOut() > 0
            ? [
                `${plural(output.linesLeftOut(), "line")} left out · all of it in ${localContext.failuresReportPath}`,
              ]
            : []),
          ...(warningOutput.linesLeftOut() > 0
            ? [
                `${plural(warningOutput.linesLeftOut(), "warning line")} left out · each in its node's log in ${localContext.logDir}/`,
              ]
            : []),
          "style: failures · every node's log inline: --output-style=grouped",
        ]),
      ),
    interrupt: (run) => writeText(textOf(interruptedLines(run, localContext))),
    printLine: (line: string) => printLines([line]),
  } satisfies RunListener & { printLine: (line: string) => void };
}
