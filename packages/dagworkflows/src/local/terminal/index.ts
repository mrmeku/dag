import type { Clock } from "@mrmeku/dagraph";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { styleText } from "node:util";
import { createSupportsHyperlinks } from "supports-hyperlinks";
import type { OutputStyle } from "../../config/index.ts";
import { warningsOf } from "../../github-workflow-commands/index.ts";
import type { Host } from "../../host/index.ts";
import { logLines } from "../../kernel/index.ts";
import { githubRenderer } from "../../reporter/index.ts";
import type { RunListener } from "../../run-store/index.ts";
import type { WriteStreams } from "../../wiring/index.ts";
import { localRerunCommand, type LocalContext, type LocalFiles } from "../words/index.ts";
import { createAgentRenderer } from "./agent.ts";
import { createLiveRenderer } from "./live.ts";

/** A style asked for wins; then CI gets grouped, an agent failures even on a terminal, a terminal live. */
export function outputStyleFor(
  chosen: OutputStyle | undefined,
  facts: { isCI: boolean; isAgent: boolean; isTerminal: boolean; term: string | undefined },
): OutputStyle {
  if (chosen) return chosen;
  if (facts.isCI) return "grouped";
  if (facts.isAgent) return "failures";
  return facts.isTerminal && facts.term !== "dumb" ? "live" : "grouped";
}

/** The `grouped` style: GitHub's renderer on the local host, each warning rewritten as the host prints it. */
function createGroupedRenderer(host: Host, workflowFile: string | undefined): RunListener {
  const renderer = githubRenderer(host, { rerunCommand: localRerunCommand(workflowFile) });
  return {
    ...renderer,
    settle: (nodeState, run, log) => {
      const warningsByLine = Map.groupBy(warningsOf(log), ({ line }) => line);
      const shown = log.flatMap((line, index) => {
        const lineWarnings = warningsByLine.get(index);
        return lineWarnings === undefined
          ? [line]
          : lineWarnings.flatMap(({ message }) =>
              logLines(`[warning] ${nodeState.node.name}: ${message}`),
            );
      });
      renderer.settle?.(nodeState, run, shown);
    },
  };
}

/**
 * The terminal in `style`: the listener, and, for `live` and `failures`, the `printLine` other
 * writers go through so their lines land above the footer or count against the budget.
 */
export function createTerminal({
  style,
  files,
  streams,
  clock,
  host,
}: {
  style: OutputStyle;
  files: LocalFiles;
  streams: WriteStreams;
  clock: Pick<Clock, "epochMilliseconds">;
  host: Host;
}): { listener: RunListener; printLine?: (line: string) => void } {
  switch (style) {
    case "live": {
      const useColor = streams.stdout.hasColors?.() === true;
      const useHyperlinks = createSupportsHyperlinks(streams.stdout);
      const localContext: LocalContext = {
        ...files,
        paint: (textStyle, text) =>
          useColor && text ? styleText(textStyle, text, { validateStream: false }) : text,
        link: (path) =>
          useHyperlinks
            ? `\x1b]8;;${pathToFileURL(resolve(path)).href}\x1b\\${path}\x1b]8;;\x1b\\`
            : path,
      };
      const live = createLiveRenderer(localContext, streams, clock);
      return { listener: live, printLine: live.printLine };
    }
    case "failures": {
      const plain: LocalContext = {
        ...files,
        paint: (_textStyle, text) => text,
        link: (path) => path,
      };
      const agent = createAgentRenderer(plain, (text) => void streams.stdout.write(text));
      return { listener: agent, printLine: agent.printLine };
    }
    case "grouped":
      return { listener: createGroupedRenderer(host, files.workflowFile) };
  }
}
