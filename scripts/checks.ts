import type { NodeRef, Workflow } from "@mrmeku/dagworkflows";

/** A package this repository publishes. */
export type Package = "dagraph" | "dagworkflows";

/** A package packed for npm, its `tarball` the .tgz. */
type Tarball = NodeRef<Record<"tarball", string>>;

/** The action's bundle, its `main` and `post` entries. */
type ActionBundle = NodeRef<Record<"main" | "post", string>>;

const TOOLCHAIN = ["package.json", "bun.lock", "tsconfig.json"];
// A version no release uses: a pack check packs each package as a release would.
const PACK_VERSION = "0.0.0-ci";
const ENGINE = "packages/dagraph/src/**";
const PACKED = [
  "packages/*/src/**",
  "packages/*/package.json",
  "packages/*/README.md",
  "tsconfig.build.json",
  "scripts/pack.ts",
  ...TOOLCHAIN,
];

/** Each package packed as a release packs it, so a change that breaks packing fails CI. */
export async function addPackChecks(
  workflow: Workflow<"test">,
  cacheRestore: NodeRef,
): Promise<Record<Package, Tarball>> {
  const sources = await workflow.glob(...PACKED);
  const pack = (pkg: Package) =>
    workflow.task({
      name: `pack:${pkg}`,
      cmd: ({ outputDir }) => ["bun", "scripts/pack.ts", pkg, PACK_VERSION, outputDir],
      outputs: { tarball: `mrmeku-${pkg}-${PACK_VERSION}.tgz` },
      inputs: sources,
      deps: { cache: cacheRestore },
    });
  return { dagraph: pack("dagraph"), dagworkflows: pack("dagworkflows") };
}

/** The action's bundle, built as a release ships it. */
export async function addActionBuild(
  workflow: Workflow,
  cacheRestore: NodeRef,
): Promise<ActionBundle> {
  return workflow.task({
    name: "build:action",
    cmd: ({ outputDir }) => [
      "bun",
      "build",
      "packages/dagworkflows/src/action/main.ts",
      "packages/dagworkflows/src/action/post.ts",
      "--target=node",
      "--format=esm",
      "--outdir",
      outputDir,
    ],
    outputs: { main: "main.js", post: "post.js" },
    inputs: await workflow.glob(...PACKED),
    deps: { cache: cacheRestore },
  });
}

/** The packed packages and the action's bundle, installed and run as their consumers run them. */
export function addEndToEndTests(
  workflow: Workflow,
  tarballs: Record<Package, Tarball>,
  bundle: ActionBundle,
) {
  return workflow.task({
    name: "test:e2e",
    cmd: [
      "node",
      "--test",
      "packages/dagworkflows/src/cli/main.e2e.ts",
      "packages/dagworkflows/src/action/bundle.e2e.ts",
    ],
    env: ({ dagraph, dagworkflows, bundle }) => ({
      DAGRAPH_TARBALL: dagraph.tarball,
      DAGWORKFLOWS_TARBALL: dagworkflows.tarball,
      ACTION_MAIN: bundle.main,
      ACTION_POST: bundle.post,
    }),
    deps: { ...tarballs, bundle },
    // npm resolves the tarballs' dependency ranges against the registry, which no input pins.
    cacheable: false,
  });
}

export async function addChecks(
  workflow: Workflow<"test">,
  cacheRestore: NodeRef,
  others: Record<string, NodeRef> = {},
): Promise<NodeRef> {
  // Each check orders after the cache restore.
  const afterRestore = { deps: { cache: cacheRestore } };
  const [all, engine, runner] = await Promise.all([
    workflow.glob(
      "packages/*/src/**",
      "packages/dagraph/lint/**",
      "scripts/**",
      "eslint.config.ts",
      "eslint.dagraph.ts",
      "eslint.dagworkflows.ts",
      ...TOOLCHAIN,
    ),
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
