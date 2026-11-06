import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, test } from "node:test";

/**
 * The action's bundle inlines everything its entries reach, dynamic imports included, and its
 * entries re-export the package index. A local run's display is the CLI's alone: this walks the
 * entries' import graph and fails on the first module under `local/` but its host, or of the
 * packages only the display uses.
 */
const SRC = resolve(import.meta.dirname, "..");
const LOCAL_ONLY_PACKAGES = ["std-env", "shlex", "string-width", "supports-hyperlinks"];
const isLocalOnly = (file: string) => {
  const path = relative(SRC, file);
  return (
    path.startsWith("local/") && path !== "local/local-host.ts" && !path.startsWith("local/host/")
  );
};
const IMPORT_RE =
  /(?:import|export)\s[^"'`]*?from\s+["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

const specsOf = (source: string) =>
  [...source.matchAll(IMPORT_RE)].map(([, from, bare, dynamic]) => from ?? bare ?? dynamic ?? "");

function walk(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const offenders: string[] = [];
  for (const spec of specsOf(readFileSync(file, "utf8"))) {
    if (LOCAL_ONLY_PACKAGES.includes(spec))
      offenders.push(`${relative(SRC, file)} imports ${spec}`);
    if (!spec.startsWith(".")) continue;
    const target = resolve(dirname(file), spec);
    if (isLocalOnly(target)) offenders.push(`${relative(SRC, file)} imports ${spec}`);
    else offenders.push(...walk(target, seen));
  }
  return offenders;
}

/** What an entry re-exports whole, as paths from `src/`. */
const reexportsOf = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(/^export \* from ["']([^"']+)["'];$/gm)].map(([, spec]) =>
    relative(SRC, resolve(dirname(file), spec ?? "")),
  );

describe("action bundle", () => {
  test("reaches no local display or the packages it alone uses, whatever form the import takes, so the action carries only what GitHub runs", () => {
    const entries = [resolve(SRC, "action/main.ts"), resolve(SRC, "action/post.ts")];
    assert.deepEqual(
      {
        offenders: entries.flatMap((entry) => walk(entry)),
        forms: specsOf(
          'import a from "./a.ts"; import "./b.ts"; export * from "../c.ts"; await import(`./d.ts`); import("shlex"); import type { E } from "./e.ts";',
        ),
        flagged: [
          "local/terminal/index.ts",
          "local/index.ts",
          "local/local-host.ts",
          "local/host/index.ts",
        ].map((path) => isLocalOnly(resolve(SRC, path))),
      },
      {
        offenders: [],
        forms: ["./a.ts", "./b.ts", "../c.ts", "./d.ts", "shlex", "./e.ts"],
        flagged: [true, true, false, false],
      },
    );
  });

  test("each entry exports what the package index exports", () => {
    assert.deepEqual(
      {
        main: reexportsOf(resolve(SRC, "action/main.ts")),
        post: reexportsOf(resolve(SRC, "action/post.ts")),
      },
      { main: ["index.ts"], post: ["index.ts"] },
    );
  });
});
