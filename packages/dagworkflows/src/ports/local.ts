import { cp, lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { CACHE_LOCK_RETRY_MS } from "../config.ts";
import { annotationLine } from "../kernel/format.ts";
import type { CacheStore, Host, Ports } from "../ports.ts";

/**
 * Local adapter: the same reporter output as GitHub, rendered for a terminal. Groups become
 * indented blocks, annotations become tagged lines, and the summary is written to a file.
 * Context comes from git: `ref` in the toolkit's form, `refs/heads/<branch>`, or "" on a detached
 * HEAD, as GitHub leaves it unset for an event with no branch or tag. This is what makes
 * `bun run ci` on a laptop identical to the job.
 */
export function createLocalHost(
  opts: Pick<Ports, "exec" | "fs"> & { summaryPath: string; write?: (line: string) => void },
): Host {
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
    annotate: (level, title, message) => write(annotationLine(level, title, message)),
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

/**
 * Whether `path` holds anything: a file or a link, one that leads nowhere included, or a directory
 * with one anywhere in it. A run makes the CAS directory, empty, before its restore runs.
 */
async function holdsAnything(path: string): Promise<boolean> {
  const stats = await lstat(path).catch(() => undefined);
  if (stats === undefined) return false;
  if (!stats.isDirectory()) return true;
  for (const name of await readdir(path)) if (await holdsAnything(join(path, name))) return true;
  return false;
}

/**
 * The local cache store, which ignores keys. A cache's paths stay on disk where the run left them,
 * so a save does nothing. In a worktree, a restore copies each relative path that holds nothing
 * from the same place in the main checkout, holding a lock on the path, and resolves to the main
 * checkout if it copied one. It keeps what the worktree has, and never touches a path outside it.
 */
export function createWorktreeCacheStore({
  exec,
  lockfile,
}: Pick<Ports, "exec" | "lockfile">): CacheStore {
  const git = async (...args: string[]) => {
    const result = await exec.run(["git", ...args]);
    return result.ok ? result.stdout.trim() : undefined;
  };
  return {
    restore: async (paths) => {
      const [worktrees, root, prefix] = await Promise.all([
        git("worktree", "list", "--porcelain"),
        git("rev-parse", "--show-toplevel"),
        git("rev-parse", "--show-prefix"),
      ]);
      const main = worktrees === undefined ? undefined : /^worktree (.+)$/m.exec(worktrees)?.[1];
      if (main === undefined || main === root || prefix === undefined) return undefined;
      let copied = false;
      for (const path of paths.filter((path) => !isAbsolute(path) && !path.startsWith("~"))) {
        const source = join(main, prefix, path);
        await mkdir(dirname(path), { recursive: true });
        const release = await lockfile.lock(path, {
          lockfilePath: `${path}.lock`,
          realpath: false,
          retries: {
            forever: true,
            minTimeout: CACHE_LOCK_RETRY_MS,
            maxTimeout: CACHE_LOCK_RETRY_MS,
          },
          onCompromised: (e) => process.emitWarning(`the lock on ${path} was lost: ${e.message}`),
        });
        try {
          if (!(await holdsAnything(path)) && (await holdsAnything(source))) {
            await cp(source, path, {
              recursive: true,
              verbatimSymlinks: true,
              preserveTimestamps: true,
            });
            copied = true;
          }
        } finally {
          await release().catch(() => {});
        }
      }
      return copied ? main : undefined;
    },
    save: async () => false,
  };
}
