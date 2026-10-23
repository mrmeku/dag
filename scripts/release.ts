/**
 * The release as a dagworkflows workflow, run by .github/workflows/release.yml on a `v*` tag.
 * `bun run release` runs it locally as a dry run: real tarballs and the action bundle land in the
 * CAS, nothing is published.
 *
 * - version: a `v1.2.3` tag releases 1.2.3; any other ref is a dry run of `0.0.0-dev.<sha>`.
 * - cache: the CAS restored from this release's own earlier attempt first, then main's, and
 *   saved under the release key whatever happened, so a re-run after a partial failure finds the
 *   receipts of what already published and skips it.
 * - checks: the same nodes as CI (scripts/checks.ts), so a tree CI already tested is a cache hit.
 * - pack: one tarball per package, a declared output, content-addressed. One build program emits
 *   both packages, so each pack reads both packages' sources. The engine is published before the
 *   runner that depends on it.
 * - publish: a receipt. Cached by the tarball it published and the command, so a re-run skips it;
 *   runs only after require-all. A dry run publishes with --dry-run: a different command, a
 *   different key, never confused with the real one. A prerelease version goes under the `next`
 *   dist-tag, which npm 11 insists on, so `latest` only ever moves to a release. npm
 *   authenticates through trusted publishing, which also attaches provenance.
 * - action: the bundle (main and post entries) is an output of build:action; release:action
 *   pushes it to github.com/mrmeku/dagworkflows, the ref consumers use, and tags it.
 * - upload: each tarball and the bundle go up as artifacts of the run as soon as they are built,
 *   whether or not require-all passes, so what a dry run or a failed publish would have shipped
 *   can be inspected.
 */
import { defineWorkflow, type NodeRef } from "@mrmeku/dagworkflows";
import { addChecks } from "./checks.ts";

type Pkg = "dagraph" | "dagworkflows";
const TAG = /^refs\/tags\/v(\d+\.\d+\.\d+(?:-[\w.]+)?)$/;
const TOOLCHAIN = ["tsconfig.json", "tsconfig.build.json", "bun.lock", "scripts/pack.ts"];

export default defineWorkflow({
  schedulerOptions: { maxParallelism: 4, concurrencyLimits: { test: 2 } },
  implementation: async (workflow) => {
    const tagged = TAG.exec(workflow.ctx.ref)?.[1];
    const version = tagged ?? `0.0.0-dev.${workflow.ctx.sha.slice(0, 7) || "local"}`;
    const dryRun = tagged === undefined;

    const cas = workflow.restoreCache({
      name: "restore:cas",
      path: [".dag/cas"],
      key: `dag-release-${version}-${workflow.ctx.sha}`,
      restoreKeys: [`dag-release-${version}-`, "dag-main-"],
    });
    const afterCas = { deps: { cas }, invalidateOn: { cas: () => "" } };
    const requireAll = await addChecks(workflow, cas);

    const sources = await workflow.glob(
      "packages/*/src/**",
      "packages/*/package.json",
      "packages/*/README.md",
      ...TOOLCHAIN,
    );
    const pack = (pkg: Pkg) => {
      const tarball = workflow.task({
        name: `pack:${pkg}`,
        cmd: ({ outputDir }) => ["bun", "scripts/pack.ts", pkg, version, outputDir],
        outputs: { tarball: `mrmeku-${pkg}-${version}.tgz` },
        inputs: sources,
        ...afterCas,
      });
      workflow.uploadArtifact({
        name: `upload:${pkg}`,
        artifact: `${pkg}-${version}`,
        path: ({ pack }) => [pack.tarball],
        deps: { pack: tarball },
      });
      return tarball;
    };
    const tarballs = { dagraph: pack("dagraph"), dagworkflows: pack("dagworkflows") };
    const bundle = workflow.task({
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
      inputs: sources,
      ...afterCas,
    });

    workflow.uploadArtifact({
      name: "upload:action",
      artifact: `action-${version}`,
      path: ({ bundle }) => [bundle.main, bundle.post],
      deps: { bundle },
    });

    const publish = (pkg: Pkg, after: { engine?: NodeRef }) =>
      workflow.task({
        name: `publish:${pkg}`,
        cmd: ({ pack }) => [
          "npm",
          "publish",
          pack.tarball,
          "--access",
          "public",
          ...(version.includes("-") ? ["--tag", "next"] : []),
          ...(dryRun ? ["--dry-run"] : []),
        ],
        deps: { requireAll, pack: tarballs[pkg], ...after },
        cacheable: true,
      });
    const engine = publish("dagraph", {});
    const published = { dagraph: engine, dagworkflows: publish("dagworkflows", { engine }) };
    const action = workflow.task({
      name: "release:action",
      cmd: ({ bundle }) => [
        "bun",
        "scripts/release-action.ts",
        version,
        bundle.main,
        bundle.post,
        ...(dryRun ? ["--dry-run"] : []),
      ],
      deps: { requireAll, bundle },
      cacheable: true,
    });

    const release = workflow.requireAll({ name: "release", deps: { ...published, action } });
    workflow.saveCache({ name: "save:cas", cache: cas });
    return { version, dryRun, release };
  },
});
