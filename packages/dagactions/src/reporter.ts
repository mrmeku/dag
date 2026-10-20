import type { Node, Result } from "@mrmeku/dagraph";
import { createGithubStore } from "./github/renderer.ts";
import { titleOf } from "./kernel/format.ts";
import type { Pass } from "./kernel/run-slice.ts";
import type { RunStore } from "./kernel/store.ts";
import type { Ports } from "./ports.ts";
import { DEFAULT_SUMMARY_RENDERERS, renderSummary, type SummaryRenderer } from "./summary.ts";

/**
 * The end of a pass on a run store, once every settle is told: the step summary drawn by
 * `renderers` published, then the pass finished.
 */
export async function finishPass(
  ports: Pick<Ports, "ci">,
  store: RunStore,
  pass: Pass,
  results: Result[],
  renderers: readonly SummaryRenderer[] = DEFAULT_SUMMARY_RENDERERS,
): Promise<{ failed: number; markdown: string }> {
  const nodes = await store.report(pass);
  const markdown = await renderSummary(
    pass.title,
    { nodes, log: store.log },
    renderers,
    (message) => ports.ci.annotate("warning", "dagactions summary", message),
  );
  await ports.ci.summary(markdown);
  await store.finish(pass, nodes);
  const failed = results.filter((r) => r.status !== "done" && r.status !== "cached").length;
  return { failed, markdown };
}

/**
 * Turns dagraph's event stream into CI output as the GitHub renderer draws it
 * (github/renderer.ts), with a markdown summary drawn by the renderers in `summary`
 * (summary.ts). `rerunCommand` is the command that ran this workflow, for the recap's reproduce line.
 * Logs are read back from beside the CAS, which is why cached and failed nodes still show their output.
 */
export function createReporter(
  ports: Ports,
  opts: {
    casBaseDir: string;
    nodes: Node[];
    title?: string;
    rerunCommand?: string;
    summary?: readonly SummaryRenderer[];
  },
) {
  const pass: Pass = {
    title: opts.title ?? titleOf(undefined),
    nodes: opts.nodes,
    ...(opts.rerunCommand && { rerunCommand: opts.rerunCommand }),
  };
  const store = createGithubStore(ports, opts.casBaseDir);
  store.begin(pass);
  return {
    onEvent: store.onEvent,
    finish: (results: Result[]) => finishPass(ports, store, pass, results, opts.summary),
  };
}
