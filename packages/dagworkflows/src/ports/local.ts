import type { DagFs } from "@mrmeku/dagraph";
import { dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Exec, Host } from "../ports.ts";

/**
 * Local adapter: the same reporter output as GitHub, rendered for a terminal. Groups become
 * indented blocks, annotations become tagged lines, and the summary is written to a file.
 * Context comes from git. This is what makes `bun run ci` on a laptop identical to the job.
 */
export function createLocalHost(opts: {
  exec: Exec;
  fs: DagFs;
  summaryPath: string;
  write?: (line: string) => void;
}): Host {
  const write = opts.write ?? ((line) => console.log(line));
  let written = false;
  const git = async (...args: string[]) => (await opts.exec.run(["git", ...args])).stdout.trim();
  return {
    context: async () => ({
      isCi: false,
      provider: "local",
      ref: await git("rev-parse", "--abbrev-ref", "HEAD"),
      sha: await git("rev-parse", "HEAD"),
      eventName: "local",
      actor: (await git("config", "user.name")) || process.env.USER || "",
      runId: 0,
      repo: { owner: "", repo: "" },
      serverUrl: "",
    }),
    group: (title, lines) => {
      write(`▶ ${title}`);
      for (const line of lines) write(`    ${line}`);
    },
    info: (line) => write(line),
    annotate: (level, title, message) => {
      write(`[${level}] ${title}: ${message}`);
    },
    // Appends within a process, as $GITHUB_STEP_SUMMARY does, so a post pass's summary follows the run's.
    summary: async (markdown) => {
      await opts.fs.ensureDir(dirname(opts.summaryPath));
      const before =
        written && (await opts.fs.exists(opts.summaryPath))
          ? await opts.fs.readText(opts.summaryPath)
          : "";
      written = true;
      // A command's log can carry escape codes, which markdown would show raw.
      await opts.fs.writeText(opts.summaryPath, before + stripVTControlCharacters(markdown));
      write(`summary: ${opts.summaryPath}`);
    },
    // Check runs are a GitHub concept; the terminal groups already show live status.
    check: async () => {},
  };
}

/** A Host that does nothing — for library users who only want the results. */
export function nullHost(): Host {
  return {
    context: async () => ({
      isCi: false,
      provider: "none",
      ref: "",
      sha: "",
      eventName: "",
      actor: "",
      runId: 0,
      repo: { owner: "", repo: "" },
      serverUrl: "",
    }),
    group: () => {},
    info: () => {},
    annotate: () => {},
    summary: async () => {},
    check: async () => {},
  };
}
