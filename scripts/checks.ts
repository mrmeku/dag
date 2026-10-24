import type { NodeRef, Workflow } from "@mrmeku/dagworkflows";

const TOOLCHAIN = ["package.json", "bun.lock", "tsconfig.json"];
// A version no release uses: a pack check packs each package as a release would.
const PACK_VERSION = "0.0.0-ci";
const ENGINE = "packages/dagraph/src/**";

/** Each package packed as a release packs it, so a change that breaks packing fails CI. */
export async function addPackChecks(
  workflow: Workflow<"test">,
  casRestore: NodeRef,
): Promise<Record<string, NodeRef>> {
  const sources = await workflow.glob(
    "packages/*/src/**",
    "packages/*/package.json",
    "packages/*/README.md",
    "tsconfig.build.json",
    "scripts/pack.ts",
    ...TOOLCHAIN,
  );
  const pack = (pkg: "dagraph" | "dagworkflows") =>
    workflow.task({
      name: `pack:${pkg}`,
      cmd: ({ outputDir }) => ["bun", "scripts/pack.ts", pkg, PACK_VERSION, outputDir],
      outputs: { tarball: `mrmeku-${pkg}-${PACK_VERSION}.tgz` },
      inputs: sources,
      deps: { cas: casRestore },
    });
  return { "pack:dagraph": pack("dagraph"), "pack:dagworkflows": pack("dagworkflows") };
}

export async function addChecks(
  workflow: Workflow<"test">,
  casRestore: NodeRef,
  others: Record<string, NodeRef> = {},
): Promise<NodeRef> {
  // Each check orders after the CAS restore.
  const afterRestore = { deps: { cas: casRestore } };
  const [all, engine, runner] = await Promise.all([
    workflow.glob("packages/*/src/**", "scripts/**", "eslint.config.ts", ...TOOLCHAIN),
    workflow.glob(ENGINE, ...TOOLCHAIN),
    workflow.glob(ENGINE, "packages/dagworkflows/src/**", "scripts/**", ...TOOLCHAIN),
  ]);
  const typecheck = workflow.task({
    name: "typecheck",
    cmd: ["bun", "run", "typecheck"],
    inputs: all,
    ...afterRestore,
  });
  const lint = workflow.task({
    name: "lint",
    cmd: ["bun", "run", "lint"],
    inputs: all,
    ...afterRestore,
  });
  // "./" anchors the path: a bare one is a substring filter for bun test.
  const testDagraph = workflow.task({
    name: "test:dagraph",
    cmd: ["bun", "test", "./packages/dagraph"],
    inputs: engine,
    concurrencyGroup: "test",
    ...afterRestore,
  });
  const testDagworkflows = workflow.task({
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
      ...others,
    },
  });
}
