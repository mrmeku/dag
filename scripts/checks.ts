/**
 * The checks, shared by ci.ts and release.ts: a record, not a sequence, so they all start at
 * once (within the workflow's limits) and only the gate waits. Each check orders after `after`
 * (the CAS restore, which it reads nothing from) and declares the files it reads, so a README
 * edit re-runs nothing and an engine edit re-runs only the nodes that import it.
 */
import type { Steps } from "@mrmeku/dagactions";
import type { NodeRef, Outputs } from "@mrmeku/dagraph";

const TOOLCHAIN = ["package.json", "bun.lock", "tsconfig.json"];
const ENGINE = "packages/dagraph/src/**";
// What scripts/reference-doc.test.ts compares, beside the sources it reads.
const REFERENCE_SOURCES = [
  "packages/dagactions/docs/reference.md",
  "packages/dagactions/action/action.yml",
  ".prettierrc",
];

export async function addChecks(w: Steps<"test">, after: NodeRef): Promise<NodeRef<string>> {
  const afterRestore = { deps: { after }, invalidateOn: { after: (_: Outputs) => "" } };
  const [all, engine, runner] = await Promise.all([
    w.glob("packages/*/src/**", "scripts/**", "eslint.config.ts", ...TOOLCHAIN),
    w.glob(ENGINE, ...TOOLCHAIN),
    w.glob(ENGINE, "packages/dagactions/src/**", "scripts/**", ...REFERENCE_SOURCES, ...TOOLCHAIN),
  ]);
  const checks = w.runAll({
    typecheck: { cmd: ["bun", "run", "typecheck"], inputs: all, ...afterRestore },
    lint: { cmd: ["bun", "run", "lint"], inputs: all, ...afterRestore },
    // "./" anchors the path: a bare one is a substring filter for bun test.
    "test:dagraph": {
      cmd: ["bun", "test", "./packages/dagraph"],
      inputs: engine,
      group: "test",
      ...afterRestore,
    },
    "test:dagactions": {
      cmd: ["node", "--test", "packages/dagactions/src/**/*.test.ts", "scripts/*.test.ts"],
      inputs: runner,
      group: "test",
      ...afterRestore,
    },
  });
  return w.gate({ deps: checks });
}
