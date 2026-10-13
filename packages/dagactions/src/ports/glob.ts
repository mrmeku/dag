import { glob as fsGlob } from "node:fs/promises";
import { join, relative } from "node:path";
import { DEFAULT_EXCLUDES } from "../config.ts";

/**
 * The files matching any of `patterns`, sorted and deduplicated, as paths relative to the process
 * cwd, never descending into an excluded directory. Hand the result to a node's `inputs` so the
 * engine folds the files' content hashes into its key — the `hashFiles(...)` of a workflow, done
 * by the engine. Declare only what the command reads: a node whose inputs are `src/**` does not
 * re-run when the README changes.
 */
export async function glob(
  patterns: string[],
  opts: { cwd?: string; exclude?: string[] } = {},
): Promise<string[]> {
  const cwd = opts.cwd ?? ".";
  const skip = new Set(opts.exclude ?? DEFAULT_EXCLUDES);
  const files = new Set<string>();
  const entries = fsGlob(patterns, { cwd, withFileTypes: true, exclude: (e) => skip.has(e.name) });
  for await (const entry of entries) {
    if (!entry.isFile()) continue;
    const rel = relative(cwd, join(entry.parentPath, entry.name));
    files.add(cwd === "." ? rel : `${cwd}/${rel}`);
  }
  return [...files].sort();
}
