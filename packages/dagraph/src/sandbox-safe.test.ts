import { describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";

/**
 * Temporal bundles whatever the package index reaches into its V8 workflow sandbox, where
 * webpack rejects `node:` and `bun` imports. Runtime adapters that need them (the Bun
 * filesystem) are published as subpaths instead. This walks the index's static import graph
 * and fails on the first forbidden specifier, so the regression is caught here, not in CI's
 * Temporal bundling step.
 */
const FORBIDDEN = /^(node:|bun$|fs$|fs\/|child_process$|os$|path$)/;
const IMPORT_RE = /(?:import|export)\s[^"']*?from\s+["']([^"']+)["']/g;

async function walk(file: string, seen = new Set<string>()): Promise<string[]> {
  if (seen.has(file)) return [];
  seen.add(file);
  const source = await Bun.file(file).text();
  const offenders: string[] = [];
  for (const [, spec] of source.matchAll(IMPORT_RE)) {
    if (!spec) continue;
    if (FORBIDDEN.test(spec)) offenders.push(`${file} imports ${spec}`);
    if (!spec.startsWith(".")) continue;
    offenders.push(...(await walk(resolve(dirname(file), spec), seen)));
  }
  return offenders;
}

describe("package index", () => {
  test("reaches no I/O modules, so Temporal can bundle it into the workflow sandbox", async () => {
    expect(await walk(resolve(import.meta.dir, "index.ts"))).toEqual([]);
  });
});
