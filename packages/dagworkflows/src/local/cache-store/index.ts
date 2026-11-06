import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { promisify } from "node:util";
import type { CacheStore } from "../../actions-cache/index.ts";
import { CACHE_LOCK_RETRY_MS } from "../../config/index.ts";
import { lockOptions, type Lockfile } from "../../lock/index.ts";

/**
 * Whether `path` holds anything: a file or a link, one that leads nowhere included, or a directory
 * with one anywhere in it. A run makes its cache dir, empty, before its restore runs.
 */
async function holdsAnything(path: string): Promise<boolean> {
  const stats = await lstat(path).catch(() => undefined);
  if (stats === undefined) return false;
  if (!stats.isDirectory()) return true;
  for (const name of await readdir(path)) if (await holdsAnything(join(path, name))) return true;
  return false;
}

/** Git's stdout, trimmed, or undefined when it failed. */
const git = (...args: string[]) =>
  promisify(execFile)("git", args).then(
    ({ stdout }) => stdout.trim(),
    () => undefined,
  );

/**
 * The local cache store, which ignores cache keys. A cache's paths stay on disk where the run
 * left them, so a save does nothing. In a worktree, a restore copies each relative path that holds
 * nothing from the same place in the main checkout, holding a lock on the path, and resolves to
 * the main checkout if it copied one. It keeps what the worktree has, and never touches a path
 * outside it. It runs git and copies on the disk itself: only its lock goes through a port.
 */
export function createWorktreeCacheStore(lockfile: Lockfile): CacheStore {
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
      // Only paths in this checkout: none absolute, under a home or climbing out of it.
      const inCheckout = (path: string) => {
        const placed = normalize(join(prefix, path));
        return placed !== ".." && !placed.startsWith(`..${sep}`);
      };
      const relativePaths = paths.filter(
        (path) => !isAbsolute(path) && !path.startsWith("~") && inCheckout(path),
      );
      for (const path of relativePaths) {
        const source = join(main, prefix, path);
        await mkdir(dirname(path), { recursive: true });
        const release = await lockfile.lock(path, {
          ...lockOptions(path),
          retries: {
            forever: true,
            minTimeout: CACHE_LOCK_RETRY_MS,
            maxTimeout: CACHE_LOCK_RETRY_MS,
          },
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
