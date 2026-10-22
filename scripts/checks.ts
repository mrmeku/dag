import type { NodeRef, Workflow } from "@mrmeku/dagworkflows";

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
  // Each check orders after the CAS restore but reads nothing from it.
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
  const typecheck = workflow.run({
    name: "typecheck",
    cmd: ["bun", "run", "typecheck"],
    inputs: all,
    ...afterRestore,
  });
  const lint = workflow.run({
    name: "lint",
    cmd: ["bun", "run", "lint"],
    inputs: all,
    ...afterRestore,
  });
  // "./" anchors the path: a bare one is a substring filter for bun test.
  const testDagraph = workflow.run({
    name: "test:dagraph",
    cmd: ["bun", "test", "./packages/dagraph"],
    inputs: engine,
    concurrencyGroup: "test",
    ...afterRestore,
  });
  const testDagworkflows = workflow.run({
    name: "test:dagworkflows",
    cmd: ["node", "--test", "packages/dagworkflows/src/**/*.test.ts", "scripts/*.test.ts"],
    inputs: runner,
    concurrencyGroup: "test",
    ...afterRestore,
  });
  return workflow.requireAll({
    deps: {
      typecheck,
      lint,
      "test:dagraph": testDagraph,
      "test:dagworkflows": testDagworkflows,
    },
  });
}
