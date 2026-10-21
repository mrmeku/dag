import { createMemoryActionsCache, createTestPorts, okSh, type Ports } from "@mrmeku/dagactions";
import { Graph, namedOutput, soleOutput } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { basename } from "node:path";
import { describe, test } from "node:test";
import { commandOf, processEach } from "./process-each.ts";
import release from "./release.ts";

describe("release workflow", () => {
  test("a tag releases its version, any other ref dry-runs; packs are outputs, publishes are receipts after the gate, the engine before the runner", async () => {
    const build = async (ref: string) => {
      // An earlier attempt of this release, and main's CAS before it.
      const actionsCache = createMemoryActionsCache([
        "dagactions-release-1.2.3-0",
        "dagactions-main-1",
      ]);
      // pack and build:action write the files they declare.
      const { ports, fs, actionsArtifact } = createTestPorts({
        context: { ref, sha: "abc1234def" },
        actionsCache,
        sh: {
          run: async (cmd, opts) => {
            const out = opts?.env?.["DAGACTIONS_OUT"];
            assert.ok(out, "the step's DAGACTIONS_OUT");
            const [, script, pkg, version] = cmd;
            if (script === "scripts/pack.ts") {
              assert.ok(pkg, "the package pack.ts packs");
              await fs.writeText(`${out}/mrmeku-${pkg}-${version}.tgz`, pkg);
            }
            if (cmd[1] === "build")
              for (const file of ["main.js", "post.js"]) await fs.writeText(`${out}/${file}`, file);
            return okSh.run(cmd, opts);
          },
        },
      });
      const graph = new Graph<Ports>();
      const out = await release.workflow(graph, ports, await ports.ci.context());
      const processed = await processEach(graph, ports);
      const resultOf = (name: string) => processed.get(name)?.result;
      const cmdOf = async (name: string) => (await commandOf(ports, resultOf(name)))?.cmd;
      // What a step ran, its deps' outputs resolved to their paths in the CAS.
      const ran = (name: string) => processed.get(name)?.commands[0];
      const output = (name: string, key: string) => {
        const result = resultOf(name);
        assert.ok(result?.status === "done", `${name} is done`);
        return namedOutput(result.outputs, key);
      };
      const parsed = async (path: string): Promise<unknown> => JSON.parse(await fs.readText(path));
      const restored = resultOf("restore:cas");
      return {
        nodes: graph.describe(),
        ...out,
        processed,
        resultOf,
        cmdOf,
        ran,
        output,
        restored: restored?.status === "done" && (await parsed(soleOutput(restored.outputs))),
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
    const pack = tagged.resultOf("pack:dagactions");
    assert.deepEqual(
      {
        versions: [tagged.version, tagged.dryRun, branch.version, branch.dryRun],
        names: tagged.nodes.map((n) => n.name).sort(),
        restored: [tagged.restored, branch.restored],
        saved: [tagged.saved, branch.saved],
        packCmd: await tagged.cmdOf("pack:dagraph"),
        packOutputs:
          pack?.status === "done" &&
          Object.entries(pack.outputs).map(([output, path]) => [output, basename(String(path))]),
        packInputs: tagged.processed
          .get("pack:dagactions")
          ?.files.includes("packages/dagactions/package.json"),
        publishCmd: tagged.ran("publish:dagraph"),
        dryRunPublishCmd: branch.ran("publish:dagraph"),
        publishDaghaDeps: by("publish:dagactions").deps.sort(),
        publishDagraphDeps: by("publish:dagraph").deps.sort(),
        actionCmd: tagged.ran("release:action"),
        actionDeps: by("release:action").deps.sort(),
        releaseDeps: by("release").deps.sort(),
        uploads: tagged.uploads,
        uploadDeps: ["upload:dagraph", "upload:action"].map((n) => by(n).deps),
        saveDeps: { deps: by("save:cas").deps.sort(), settled: by("save:cas").settledDeps },
        uncached: tagged.nodes.filter((n) => n.cacheable === false).map((n) => n.name),
        checksAfterRestore: tagged.nodes
          .filter((n) => /^(typecheck|lint|test:)/.test(n.name))
          .every((n) => n.deps.join() === "restore:cas"),
      },
      {
        versions: ["1.2.3", false, "0.0.0-dev.abc1234", true],
        names: [
          "build:action",
          "gate",
          "lint",
          "pack:dagactions",
          "pack:dagraph",
          "publish:dagactions",
          "publish:dagraph",
          "release",
          "release:action",
          "restore:cas",
          "save:cas",
          "test:dagactions",
          "test:dagraph",
          "typecheck",
          "upload:action",
          "upload:dagactions",
          "upload:dagraph",
        ],
        // A release restores its own earlier attempt first, a dry run main's.
        restored: ["dagactions-release-1.2.3-0", "dagactions-main-1"],
        saved: [
          [["dagactions-release-1.2.3-abc1234def", [".dagactions/cas"]]],
          [["dagactions-release-0.0.0-dev.abc1234-abc1234def", [".dagactions/cas"]]],
        ],
        packCmd: ["bun", "scripts/pack.ts", "dagraph", "1.2.3", "$DAGACTIONS_OUT"],
        packOutputs: [
          ["result", "result.json"],
          ["tarball", "mrmeku-dagactions-1.2.3.tgz"],
        ],
        packInputs: true,
        publishCmd: [
          "npm",
          "publish",
          tagged.output("pack:dagraph", "tarball"),
          "--access",
          "public",
        ],
        dryRunPublishCmd: [
          "npm",
          "publish",
          branch.output("pack:dagraph", "tarball"),
          "--access",
          "public",
          "--tag",
          "next",
          "--dry-run",
        ],
        publishDaghaDeps: ["gate", "pack:dagactions", "publish:dagraph"],
        publishDagraphDeps: ["gate", "pack:dagraph"],
        actionCmd: [
          "bun",
          "scripts/release-action.ts",
          "1.2.3",
          tagged.output("build:action", "main"),
          tagged.output("build:action", "post"),
        ],
        actionDeps: ["build:action", "gate"],
        releaseDeps: ["publish:dagactions", "publish:dagraph", "release:action"],
        uploads: [
          ["dagraph-1.2.3", ["mrmeku-dagraph-1.2.3.tgz"]],
          ["dagactions-1.2.3", ["mrmeku-dagactions-1.2.3.tgz"]],
          ["action-1.2.3", ["main.js", "post.js"]],
        ],
        uploadDeps: [["pack:dagraph"], ["build:action"]],
        saveDeps: { deps: ["release", "restore:cas"], settled: ["release"] },
        uncached: [
          "restore:cas",
          "upload:dagraph",
          "upload:dagactions",
          "upload:action",
          "save:cas",
        ],
        checksAfterRestore: true,
      },
    );
  });
});
