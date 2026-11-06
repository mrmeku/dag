import { isMissingFileError, type FileSystem } from "@mrmeku/dagraph";
import { dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Host } from "../../host/index.ts";
import type { Exec } from "../../tasks/index.ts";

/**
 * Local adapter: the same reporter output as GitHub, rendered for a terminal. Groups become
 * indented blocks, annotations become tagged lines, and the summary is written to a file.
 * Context comes from git: `ref` in the toolkit's form, `refs/heads/<branch>`, or "" on a detached
 * HEAD, as GitHub leaves it unset for an event with no branch or tag. This is what makes
 * `bun run ci` on a laptop identical to the job.
 */
export function createLocalHost(opts: {
  exec: Exec;
  fs: FileSystem;
  env: Readonly<NodeJS.ProcessEnv>;
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
      ref: await git("symbolic-ref", "HEAD"),
      sha: await git("rev-parse", "HEAD"),
      eventName: "local",
      actor: (await git("config", "user.name")) || opts.env.USER || "",
      runId: 0,
      repo: { owner: "", repo: "" },
      serverUrl: "",
    }),
    group: (title, lines) => {
      write(`▶ ${title}`);
      for (const line of lines) write(`    ${line}`);
    },
    info: (line) => write(line),
    annotate: (level, title, message) => write(`[${level}] ${title}: ${message}`),
    // Appends within a process, as $GITHUB_STEP_SUMMARY does, so a post pass's summary follows the run's.
    summary: async (markdown) => {
      await opts.fs.ensureDir(dirname(opts.summaryPath));
      const before = written
        ? await opts.fs.readText(opts.summaryPath).catch((e: unknown) => {
            if (isMissingFileError(e)) return "";
            throw e;
          })
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
