import type { AnnotationLevel, CheckUpdate, CiContext, Host } from "../../host/index.ts";

export interface RecordedHost {
  host: Host;
  /** The job log in order: a group as its title and lines, a plain line as itself. */
  log: Array<string | { title: string; lines: string[] }>;
  annotations: Array<{ level: AnnotationLevel; title: string; message: string }>;
  summaries: string[];
  checks: CheckUpdate[];
}

/** A Host that records what a run tells it: the log, annotations, summaries and check runs, in order. */
export function createRecordingHost(context: Partial<CiContext> = {}): RecordedHost {
  const rec: RecordedHost = {
    log: [],
    annotations: [],
    summaries: [],
    checks: [],
    host: {
      context: async () => ({
        isCi: false,
        provider: "recording",
        ref: "",
        sha: "",
        eventName: "",
        actor: "",
        runId: 0,
        repo: { owner: "", repo: "" },
        serverUrl: "",
        ...context,
      }),
      group: (title, lines) => void rec.log.push({ title, lines }),
      info: (line) => void rec.log.push(line),
      annotate: (level, title, message) => void rec.annotations.push({ level, title, message }),
      summary: async (markdown) => void rec.summaries.push(markdown),
      check: async (update) => void rec.checks.push(update),
    },
  };
  return rec;
}
