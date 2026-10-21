/**
 * The release as a dagactions workflow, run by .github/workflows/release.yml on a `v*` tag.
 * `bun run release` runs it locally as a dry run: real tarballs and the action bundle land in the
 * CAS, nothing is published.
 *
 * - version: a `v1.2.3` tag releases 1.2.3; any other ref is a dry run of `0.0.0-dev.<sha>`.
 * - cache: the CAS restored from this release's own earlier attempt first, then main's, and
 *   saved under the release key whatever happened, so a re-run after a partial failure finds the
 *   receipts of what already published and skips it.
 * - checks: the same nodes as CI (scripts/checks.ts), so a tree CI already tested is a cache hit.
 * - pack: one tarball per package, a declared output under $DAGACTIONS_OUT, content-addressed. One
 *   build program emits both packages, so each pack reads both packages' sources. The engine is
 *   published before the runner that depends on it.
 * - publish: a receipt. Cached by the tarball it published and the command, so a re-run skips it;
 *   runs only after the gate. A dry run publishes with --dry-run: a different command, a
 *   different key, never confused with the real one. A prerelease version goes under the `next`
 *   dist-tag, which npm 11 insists on, so `latest` only ever moves to a release. npm
 *   authenticates through trusted publishing, which also attaches provenance.
 * - action: the bundle (main and post entries) is an output of build:action; release:action
 *   pushes it to github.com/mrmeku/dagactions, the ref consumers use, and tags it.
 * - upload: each tarball and the bundle go up as artifacts of the run as soon as they are built,
 *   gate or no gate, so what a dry run or a failed publish would have shipped can be inspected.
 */
import { defineWorkflow, type RunRef } from "@mrmeku/dagactions";
import { addChecks } from "./checks.ts";

type Pkg = "dagraph" | "dagactions";
const TAG = /^refs\/tags\/v(\d+\.\d+\.\d+(?:-[\w.]+)?)$/;
const TOOLCHAIN = ["tsconfig.json", "tsconfig.build.json", "bun.lock", "scripts/pack.ts"];

export default defineWorkflow({
  limits: { maxParallelism: 4, concurrencyLimits: { test: 2 } },
  build: async (w) => {
    const tagged = TAG.exec(w.ctx.ref)?.[1];
    const version = tagged ?? `0.0.0-dev.${w.ctx.sha.slice(0, 7) || "local"}`;
    const dryRun = tagged === undefined;

    const cas = w.restoreCache({
      name: "restore:cas",
      path: [".dagactions/cas"],
      key: `dagactions-release-${version}-${w.ctx.sha}`,
      restoreKeys: [`dagactions-release-${version}-`, "dagactions-main-"],
    });
    const afterCas = { deps: { cas }, invalidateOn: { cas: () => "" } };
    const gate = await addChecks(w, cas);

    const sources = await w.glob(
      "packages/*/src/**",
      "packages/*/package.json",
      "packages/*/README.md",
      ...TOOLCHAIN,
    );
    const pack = (pkg: Pkg): RunRef<"tarball"> => {
      const tarball = w.run({
        name: `pack:${pkg}`,
        cmd: ["bun", "scripts/pack.ts", pkg, version, "$DAGACTIONS_OUT"],
        outputs: { tarball: `mrmeku-${pkg}-${version}.tgz` },
        inputs: sources,
        ...afterCas,
      });
      w.uploadArtifact({
        name: `upload:${pkg}`,
        artifact: `${pkg}-${version}`,
        path: [tarball.outputs.tarball],
        deps: { pack: tarball },
      });
      return tarball;
    };
    // In dependency order: the engine first.
    const tarballs: Record<Pkg, RunRef<"tarball">> = {
      dagraph: pack("dagraph"),
      dagactions: pack("dagactions"),
    };
    const bundle = w.run({
      name: "build:action",
      cmd: [
        "bun",
        "build",
        "packages/dagactions/src/action/main.ts",
        "packages/dagactions/src/action/post.ts",
        "--target=node",
        "--format=esm",
        "--outdir",
        "$DAGACTIONS_OUT",
      ],
      outputs: { main: "main.js", post: "post.js" },
      inputs: sources,
      ...afterCas,
    });

    w.uploadArtifact({
      name: "upload:action",
      artifact: `action-${version}`,
      path: [bundle.outputs.main, bundle.outputs.post],
      deps: { bundle },
    });

    const publish = (pkg: Pkg, engine?: RunRef): RunRef =>
      w.run({
        name: `publish:${pkg}`,
        cmd: [
          "npm",
          "publish",
          tarballs[pkg].outputs.tarball,
          "--access",
          "public",
          ...(version.includes("-") ? ["--tag", "next"] : []),
          ...(dryRun ? ["--dry-run"] : []),
        ],
        deps: { gate, pack: tarballs[pkg], ...(engine && { engine }) },
      });
    const engine = publish("dagraph");
    const published: Record<Pkg, RunRef> = {
      dagraph: engine,
      dagactions: publish("dagactions", engine),
    };
    const action = w.run({
      name: "release:action",
      cmd: [
        "bun",
        "scripts/release-action.ts",
        version,
        bundle.outputs.main,
        bundle.outputs.post,
        ...(dryRun ? ["--dry-run"] : []),
      ],
      deps: { gate, bundle },
    });

    const release = w.gate({ name: "release", deps: { ...published, action } });
    w.saveCache({ name: "save:cas", cache: cas, deps: { release: w.settled(release) } });
    return { version, dryRun, release };
  },
});
