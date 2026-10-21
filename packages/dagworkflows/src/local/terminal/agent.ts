import {
  AGENT_FAILURE_BLOCKS,
  AGENT_OUTPUT_BUDGET_CHARS,
  AGENT_TAIL_BUDGET_CHARS,
} from "../../config.ts";
import { plural, textOf } from "../../kernel/format.ts";
import * as selectors from "../../kernel/selectors.ts";
import type { RunListener } from "../../kernel/store.ts";
import type { LocalContext } from "../words.ts";
import {
  characterCountOf,
  failureBlockLines,
  failureLine,
  interruptedLines,
  passLines,
  recapLines,
  tailLines,
} from "./blocks.ts";

/**
 * The `failures` style, an agent's: append-only, own failures alone, within the budgets in
 * config.ts. Lines past the output budget are counted, and the recap says where all of it is.
 */
export function createAgentRenderer(localContext: LocalContext, writeText: (text: string) => void) {
  let outputBudgetLeft = AGENT_OUTPUT_BUDGET_CHARS;
  let tailBudgetLeft = AGENT_TAIL_BUDGET_CHARS;
  let failureBlocksPrinted = 0;
  let linesLeftOut = 0;
  const printLines = (lines: string[]) => {
    const printed: string[] = [];
    for (const line of lines) {
      if (linesLeftOut > 0 || line.length + 1 > outputBudgetLeft) linesLeftOut++;
      else {
        printed.push(line);
        outputBudgetLeft -= line.length + 1;
      }
    }
    if (printed.length > 0) writeText(textOf(printed));
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
    settle: (nodeState, run) => {
      if (!selectors.isOwnFailure(run, nodeState)) return;
      if (failureBlocksPrinted === AGENT_FAILURE_BLOCKS)
        return printLines([failureLine(nodeState, 0, localContext)]);
      failureBlocksPrinted++;
      const tail = tailLines(nodeState.log ?? [], tailBudgetLeft);
      tailBudgetLeft -= characterCountOf(tail);
      printLines(failureBlockLines(nodeState, run, localContext, tail));
    },
    close: (run) =>
      writeText(
        textOf([
          ...recapLines(run, localContext, { failuresShown: AGENT_FAILURE_BLOCKS }),
          ...(linesLeftOut > 0
            ? [
                `${plural(linesLeftOut, "line")} left out · all of it in ${localContext.failuresReportPath}`,
              ]
            : []),
          "style: failures · every node's log inline: --output-style=grouped",
        ]),
      ),
    interrupt: (run) => writeText(textOf(interruptedLines(run, localContext))),
    printLine: (line: string) => printLines([line]),
  } satisfies RunListener & { printLine: (line: string) => void };
}
