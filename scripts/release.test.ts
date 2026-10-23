import { Graph, namedOutput } from "@mrmeku/dagraph";
import {
  createMemoryActionsCache,
  createTestPorts,
  createWorkflow,
  logPath,
  okExec,
  selectNodes,
  type Ports,
} from "@mrmeku/dagworkflows";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { describe, test } from "node:test";
import { CAS, processEach } from "./process-each.ts";
import release from "./release.ts";

const BASH = ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c"];

describe("release workflow", () => {
  test("a tag releases its version, any other ref dry-runs; packs are outputs, publishes are receipts after require-all, the engine before the runner", async () => {
    const build = async (ref: string) => {
      // An earlier attempt of this release, and main's CAS before it.
      const actionsCache = createMemoryActionsCache(["dag-release-1.2.3-0", "dag-main-1"]);
      // The $TARBALL each shell line got.
      const tarballs = new Map<string | undefined, string | undefined>();
      // pack and build:action write the files they declare.
      const { ports, fs, actionsArtifact } = createTestPorts({
        context: { ref, sha: "abc1234def" },
        actionsCache,
        exec: {
          run: async (cmd, opts) => {
            const [, script, pkg, version, dir] = cmd;
            if (script === "scripts/pack.ts" && pkg)
              await fs.writeText(`${dir}/mrmeku-${pkg}-${version}.tgz`, pkg);
            if (script === "build")
              for (const file of ["main.js", "post.js"])
                await fs.writeText(`${cmd[cmd.indexOf("--outdir") + 1]}/${file}`, file);
            tarballs.set(cmd.at(-1), opts?.env?.["TARBALL"]);
            return okExec.run(cmd, opts);
          },
        },
      });
      const graph = new Graph<Ports>();
      const out = await createWorkflow(graph, ports, await ports.host.context()).compose(release);
      const processed = await processEach(graph, ports);
      const resultOf = (name: string) => processed.get(name)?.result;
      // What a step ran, its deps' outputs resolved to their paths in the CAS.
      const ran = (name: string) =>
        processed
          .get(name)
          ?.commands[0]?.map((arg) => arg.replace(/^\/cas\/\w+\/tmp-[\w-]+$/, "<outputDir>"));
      const output = (name: string, key: string) => {
        const result = resultOf(name);
        assert.ok(result?.status === "done", `${name} is done`);
        return namedOutput(result.outputs, key);
      };
      const restored = resultOf("restore:cas");
      return {
        // The graph a run executes, where the save waits for every node that reads the CAS.
        nodes: selectNodes(graph).describe(),
        ...out,
        processed,
        resultOf,
        ran,
        tarballOf: (name: string) => tarballs.get(ran(name)?.at(-1)),
        output,
        restored:
          restored?.status === "done" && (await fs.readText(logPath(CAS, restored.actionKey))),
        saved: [...actionsCache.entries].slice(2),
        uploads: [...actionsArtifact.uploads].map(([name, { files }]) => [
          name,
          files.map((file) => basename(file)),
        ]),
      };
    };
    const tagged = await build("refs/tags/v1.2.3");
    const branch = await build("refs/heads/main");
    const nodesByName = new Map(tagged.nodes.map((n) => [n.name, n]));
    const by = (name: string) => {
      const node = nodesByName.get(name);
      assert.ok(node, `no node ${name}`);
      return node;
    };
    const pack = tagged.resultOf("pack:dagworkflows");
    assert.deepEqual(
      {
        versions: [tagged.version, tagged.dryRun, branch.version, branch.dryRun],
        names: tagged.nodes.map((n) => n.name).sort(),
        restored: [tagged.restored, branch.restored],
        saved: [tagged.saved, branch.saved],
        packCmd: tagged.ran("pack:dagraph"),
        packOutputs:
          pack?.status === "done" &&
          Object.entries(pack.outputs).map(([output, path]) => [output, basename(String(path))]),
        packInputs: tagged.processed
          .get("pack:dagworkflows")
          ?.files.includes("packages/dagworkflows/package.json"),
        publishCmd: tagged.ran("publish:dagraph"),
        publishTarball: tagged.tarballOf("publish:dagraph"),
        dryRunPublishCmd: branch.ran("publish:dagraph"),
        dryRunPublishTarball: branch.tarballOf("publish:dagraph"),
        publishDagworkflowsDeps: by("publish:dagworkflows").deps.sort(),
        publishDagraphDeps: by("publish:dagraph").deps.sort(),
        actionCmd: tagged.ran("release:action"),
        actionDeps: by("release:action").deps.sort(),
        releaseDeps: by("release").deps.sort(),
        uploads: tagged.uploads,
        uploadDeps: ["upload:dagraph", "upload:action"].map((n) => by(n).deps),
        saveDeps: {
          deps: by("save:cas").deps.sort(),
          settled: by("save:cas").settledDeps?.sort(),
        },
        uncached: tagged.nodes.filter((n) => n.cacheable === false).map((n) => n.name),
        checksAfterRestore: tagged.nodes
          .filter((n) => /^(typecheck|lint|test:)/.test(n.name))
          .every((n) => n.deps.join() === "restore:cas"),
      },
      {
        versions: ["1.2.3", false, "0.0.0-dev.abc1234", true],
        names: [
          "build:action",
          "lint",
          "pack:dagraph",
          "pack:dagworkflows",
          "publish:dagraph",
          "publish:dagworkflows",
          "release",
          "release:action",
          "require-all",
          "restore:cas",
          "save:cas",
          "test:dagraph",
          "test:dagworkflows",
          "typecheck",
          "upload:action",
          "upload:dagraph",
          "upload:dagworkflows",
        ],
        // A release restores its own earlier attempt first, a dry run main's.
        restored: [
          "Cache restored from key: dag-release-1.2.3-0\n",
          "Cache restored from key: dag-main-1\n",
        ],
        saved: [
          [["dag-release-1.2.3-abc1234def", [".dag/cas"]]],
          [["dag-release-0.0.0-dev.abc1234-abc1234def", [".dag/cas"]]],
        ],
        packCmd: ["bun", "scripts/pack.ts", "dagraph", "1.2.3", "<outputDir>"],
        packOutputs: [["tarball", "mrmeku-dagworkflows-1.2.3.tgz"]],
        packInputs: true,
        // It asks npm first, so a version npm has already succeeds without a publish.
        publishCmd: [
          ...BASH,
          'npm view @mrmeku/dagraph@1.2.3 version || npm publish "$TARBALL" --access public',
        ],
        publishTarball: tagged.output("pack:dagraph", "tarball"),
        dryRunPublishCmd: [
          ...BASH,
          'npm view @mrmeku/dagraph@0.0.0-dev.abc1234 version || npm publish "$TARBALL" --access public --tag next --dry-run',
        ],
        dryRunPublishTarball: branch.output("pack:dagraph", "tarball"),
        publishDagworkflowsDeps: ["pack:dagworkflows", "publish:dagraph", "require-all"],
        publishDagraphDeps: ["pack:dagraph", "require-all"],
        actionCmd: [
          "bun",
          "scripts/release-action.ts",
          "1.2.3",
          tagged.output("build:action", "main"),
          tagged.output("build:action", "post"),
        ],
        actionDeps: ["build:action", "require-all"],
        releaseDeps: ["publish:dagraph", "publish:dagworkflows", "release:action"],
        uploads: [
          ["dagraph-1.2.3", ["mrmeku-dagraph-1.2.3.tgz"]],
          ["dagworkflows-1.2.3", ["mrmeku-dagworkflows-1.2.3.tgz"]],
          ["action-1.2.3", ["main.js", "post.js"]],
        ],
        uploadDeps: [["pack:dagraph"], ["build:action"]],
        // Every node but the restore, which it needs to have succeeded.
        saveDeps: {
          deps: [
            "build:action",
            "lint",
            "pack:dagraph",
            "pack:dagworkflows",
            "publish:dagraph",
            "publish:dagworkflows",
            "release",
            "release:action",
            "require-all",
            "restore:cas",
            "test:dagraph",
            "test:dagworkflows",
            "typecheck",
            "upload:action",
            "upload:dagraph",
            "upload:dagworkflows",
          ],
          settled: [
            "build:action",
            "lint",
            "pack:dagraph",
            "pack:dagworkflows",
            "publish:dagraph",
            "publish:dagworkflows",
            "release",
            "release:action",
            "require-all",
            "test:dagraph",
            "test:dagworkflows",
            "typecheck",
            "upload:action",
            "upload:dagraph",
            "upload:dagworkflows",
          ],
        },
        uncached: [
          "restore:cas",
          "upload:dagraph",
          "upload:dagworkflows",
          "upload:action",
          "save:cas",
        ],
        checksAfterRestore: true,
      },
    );
  });
});
