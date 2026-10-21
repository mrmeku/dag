import { create, hashFiles as toolkitHashFiles } from "@actions/glob";
import { relative } from "node:path";
import { DEFAULT_EXCLUDES } from "../config.ts";

// The globber reports every file it visits as a `::debug::` command, which GitHub hides and a
// terminal does not. Off GitHub nothing reads those commands, so they are dropped at the sink.
if (!process.env["GITHUB_ACTIONS"]) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ) =>
    typeof chunk === "string" && chunk.startsWith("::debug::")
      ? true
      : typeof encoding === "function"
        ? write(chunk, encoding)
        : write(chunk, encoding, cb);
}

const withExcludes = (patterns: string[]) =>
  [...patterns, ...DEFAULT_EXCLUDES.map((d) => `!**/${d}/**`)].join("\n");

/**
 * The files matching any of `patterns` by `@actions/glob`'s rules, the ones `actions/cache`,
 * `actions/upload-artifact` and the `hashFiles()` expression match by, sorted and deduplicated,
 * as paths relative to the process cwd; the directories in `DEFAULT_EXCLUDES` are negated.
 * Hand the result to a node's `inputs` so the engine folds the files' content hashes into its
 * key. Declare only what the command reads: a node whose inputs are `src/**` does not re-run
 * when the README changes. A negation filters but does not prune, so root a pattern below
 * `node_modules`: `src/**` walks `src`, while `**` walks the whole tree.
 */
export async function glob(patterns: string[]): Promise<string[]> {
  const globber = await create(withExcludes(patterns), { matchDirectories: false });
  const cwd = process.cwd();
  return [...new Set((await globber.glob()).map((f) => relative(cwd, f)))].sort();
}

/** The `hashFiles()` expression of a workflow file, with the same excludes as `glob`: one hash over the matched files' contents, "" when none match. */
export function hashFiles(patterns: string[]): Promise<string> {
  return toolkitHashFiles(withExcludes(patterns));
}
