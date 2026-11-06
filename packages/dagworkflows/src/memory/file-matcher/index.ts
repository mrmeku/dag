import { createHash } from "node:crypto";
import type { FileMatcher } from "../../upload-artifact/index.ts";

/**
 * Files a test names for each pattern, never the grammar: `match` gives what `matches` holds for
 * each pattern, sorted and deduplicated, a pattern it lacks giving none; `hash` the SHA-256 of
 * those paths, or "" for none.
 */
export function createMemoryFileMatcher(matches: Record<string, string[]> = {}): FileMatcher {
  const match = async (patterns: string[]) =>
    [...new Set(patterns.flatMap((pattern) => matches[pattern] ?? []))].sort();
  return {
    match,
    hash: async (patterns) => {
      const files = await match(patterns);
      return files.length === 0 ? "" : createHash("sha256").update(files.join("\n")).digest("hex");
    },
  };
}
