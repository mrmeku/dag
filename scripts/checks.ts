/**
 * The checks, shared by ci.ts and release.ts: a record, not a sequence, so they all start at
 * once, as far as the workflow's scheduler options allow, and only require-all waits. Each check
 * orders after `after` (the CAS restore, which it reads nothing from) and declares the files it
 * reads, so a README edit re-runs nothing and an engine edit re-runs only the nodes that import
 * it.
 */
import type { NodeRef } from "@mrmeku/dagraph";
import type { Workflow } from "@mrmeku/dagworkflows";

const TOOLCHAIN = ["package.json", "bun.lock", "tsconfig.json"];
const ENGINE = "packages/dagraph/src/**";
// What scripts/reference-doc.test.ts compares, beside the sources it reads.
const REFERENCE_SOURCES = [
  "packages/dagworkflows/docs/reference.md",
  "packages/dagworkflows/action/action.yml",
  ".prettierrc",
];

export async function addChecks(
  workflow: Workflow<"test">,
  after: NodeRef,
): Promise<NodeRef<string>> {
  const afterRestore = { deps: { after }, invalidateOn: { after: () => "" } };
  const [all, engine, runner] = await Promise.all([
    workflow.glob("packages/*/src/**", "scripts/**", "eslint.config.ts", ...TOOLCHAIN),
    workflow.glob(ENGINE, ...TOOLCHAIN),
    workflow.glob(
      ENGINE,
      "packages/dagworkflows/src/**",
      "scripts/**",
      ...REFERENCE_SOURCES,
      ...TOOLCHAIN,
    ),
  ]);
  const checks = workflow.runAll({
    typecheck: { cmd: ["bun", "run", "typecheck"], inputs: all, ...afterRestore },
    lint: { cmd: ["bun", "run", "lint"], inputs: all, ...afterRestore },
    // "./" anchors the path: a bare one is a substring filter for bun test.
    "test:dagraph": {
      cmd: ["bun", "test", "./packages/dagraph"],
      inputs: engine,
      group: "test",
      ...afterRestore,
    },
    "test:dagworkflows": {
      cmd: ["node", "--test", "packages/dagworkflows/src/**/*.test.ts", "scripts/*.test.ts"],
      inputs: runner,
      group: "test",
      ...afterRestore,
    },
  });
  return workflow.requireAll({ deps: checks });
}
