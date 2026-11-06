import { isSucceeded, type FileSystem, type Node, type NodeResult } from "@mrmeku/dagraph";
import { stepSummary, type SummaryRenderer } from "../github-step-summary/index.ts";
import type { Host } from "../host/index.ts";
import { titleOf, type Pass } from "../kernel/index.ts";
import { createRunStore, type RunReport } from "../run-store/index.ts";
import { DEFAULT_SUMMARY_RENDERERS } from "../summary-renderers/index.ts";
import { githubRenderer } from "./github-renderer.ts";

export { githubRenderer } from "./github-renderer.ts";

/**
 * The step summary of `report`, drawn by `renderers`, handed to the host even when empty. A
 * renderer that throws is a warning titled `dag`, and never changes an outcome. Resolves to the
 * markdown.
 */
export async function publishSummary(
  host: Host,
  title: string,
  report: RunReport,
  renderers: readonly SummaryRenderer<RunReport>[] = DEFAULT_SUMMARY_RENDERERS,
): Promise<string> {
  const { markdown, failed } = await stepSummary(title, renderers, report);
  for (const { name, message } of failed)
    host.annotate("warning", "dag", `step summary: ${name} failed: ${message}`);
  await host.summary(markdown);
  return markdown;
}

/**
 * dagraph's event stream drawn as the GitHub renderer draws it on `host`, for a program that runs
 * dagraph itself: `onEvent` for `execute`, and `finish`, which draws the recap, publishes the
 * summary drawn by `summary`, waits for check runs and writes the durations. `rerunCommand` is
 * the command that ran this workflow, for the recap's reproduce line.
 */
export function createReporter(
  { host, fs }: { host: Host; fs: FileSystem },
  opts: {
    buildLogDir?: string;
    durationsFile: string;
    nodes: Node[];
    title?: string;
    rerunCommand?: string;
    summary?: readonly SummaryRenderer<RunReport>[];
  },
) {
  const pass: Pass = {
    title: opts.title ?? titleOf(undefined),
    nodes: opts.nodes,
    ...(opts.rerunCommand && { rerunCommand: opts.rerunCommand }),
  };
  const store = createRunStore({
    fs,
    buildLogDir: opts.buildLogDir,
    durationsFile: opts.durationsFile,
    listeners: [githubRenderer(host)],
  });
  store.begin(pass);
  return {
    onEvent: store.onEvent,
    finish: async (results: NodeResult[]) => {
      await store.writeDurations();
      const nodes = await store.report(pass);
      const markdown = await publishSummary(
        host,
        pass.title,
        { nodes, log: store.log },
        opts.summary,
      );
      await store.finish(pass, nodes);
      return { failed: results.filter((result) => !isSucceeded(result)).length, markdown };
    },
  };
}
