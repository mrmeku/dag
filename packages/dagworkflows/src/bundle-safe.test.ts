import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, test } from "node:test";

/**
 * The action's bundle inlines everything its entries reach, dynamic imports included, and its
 * entries re-export the package index. A local run's terminal and recorders are the CLI's
 * alone: this walks the entries' import graph and fails on the first module under `local/`, or
 * of the packages only it uses.
 */
const LOCAL_ONLY = /(^\.{1,2}\/(.+\/)?local\/|^(std-env|string-width|supports-hyperlinks)$)/;
const IMPORT_RE =
  /(?:import|export)\s[^"'`]*?from\s+["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

const specsOf = (source: string) =>
  [...source.matchAll(IMPORT_RE)].map(([, from, bare, dynamic]) => from ?? bare ?? dynamic ?? "");

function walk(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const offenders: string[] = [];
  for (const spec of specsOf(readFileSync(file, "utf8"))) {
    if (LOCAL_ONLY.test(spec)) offenders.push(`${file} imports ${spec}`);
    if (spec.startsWith(".")) offenders.push(...walk(resolve(dirname(file), spec), seen));
  }
  return offenders;
}

describe("action bundle", () => {
  test("reaches no local terminal or recorder, whatever form the import takes, so the action carries only what GitHub runs", () => {
    const dir = resolve(import.meta.dirname, "action");
    assert.deepEqual(
      {
        offenders: [...walk(`${dir}/main.ts`), ...walk(`${dir}/post.ts`)],
        forms: specsOf(
          'import a from "./a.ts"; import "./local/b.ts"; export * from "../c.ts"; await import(`./local/d.ts`); import("e");',
        ).filter((s) => LOCAL_ONLY.test(s) || !s.startsWith(".")),
      },
      { offenders: [], forms: ["./local/b.ts", "./local/d.ts", "e"] },
    );
  });
});
