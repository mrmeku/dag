import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { createBunFileSystem } from "../filesystem/bun.ts";
import { createMemoryFileSystem } from "../filesystem/index.ts";
import { createNodeFileSystem } from "../filesystem/node.ts";
import { commitEntry, lookupEntry, newStagingDir, pruneCache } from "./cache.ts";
import type { FileSystem } from "./ports.ts";

/** The time a test that reads no last use gives the cache. */
const NOW = 0;

const roots: string[] = [];
afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const diskRoot = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dagraph-cache-")));
  roots.push(root);
  return root;
};

const filesystems: [string, () => Promise<{ fs: FileSystem; cacheDir: string }>][] = [
  ["memory", async () => ({ fs: createMemoryFileSystem(), cacheDir: "/cache" })],
  ["Bun", async () => ({ fs: createBunFileSystem(), cacheDir: `${await diskRoot()}/cache` })],
  ["Node", async () => ({ fs: createNodeFileSystem(), cacheDir: `${await diskRoot()}/cache` })],
];

/** Writes `files`, by path, into a new staging dir, and returns it with outputs naming each file by its path. */
async function stage(fs: FileSystem, cacheDir: string, files: Record<string, string>) {
  const stagingDir = newStagingDir(fs, cacheDir);
  for (const [path, content] of Object.entries(files))
    await fs.writeText(`${stagingDir}/${path}`, content);
  const outputs = Object.fromEntries(
    Object.keys(files).map((path) => [path, `${stagingDir}/${path}`]),
  );
  return { stagingDir, outputs };
}

/** Commits `files`, by path, as the entry of `key`. */
async function commit(
  fs: FileSystem,
  cacheDir: string,
  key: string,
  files: Record<string, string>,
  { writeManifest = true, now = NOW } = {},
) {
  const { stagingDir, outputs } = await stage(fs, cacheDir, files);
  return commitEntry(fs, cacheDir, key, stagingDir, outputs, writeManifest, now);
}

/** The code or message a call rejected with, or "resolved". */
const refusal = (call: Promise<unknown>) =>
  call.then(
    () => "resolved",
    (e: unknown) => (e instanceof Error ? ("code" in e ? String(e.code) : e.message) : String(e)),
  );

const isAt = (fs: FileSystem, path: string) =>
  fs.lstat(path).then(
    () => true,
    () => false,
  );

describe("the cache", () => {
  test("a commit stages under tmp and lands in v1/<key>/<content hash>, its manifest beside it, so an output named manifest.json still caches", async () => {
    const fs = createMemoryFileSystem();
    const { stagingDir, outputs } = await stage(fs, "/cache", {
      "manifest.json": "an output, not the cache entry",
    });
    const entry = await commitEntry(fs, "/cache", "k", stagingDir, outputs, true, NOW);
    const contentDir = `/cache/v1/k/${entry.contentHash}`;
    expect({
      stagingDir: stagingDir.replace(/[0-9a-f-]{36}$/, "<uuid>"),
      outputs: entry.outputs,
      found: await lookupEntry(fs, "/cache", "k", NOW),
      files: [...fs.files.keys()].sort(),
    }).toEqual({
      stagingDir: "/cache/tmp/<uuid>",
      outputs: { "manifest.json": `${contentDir}/manifest.json` },
      found: entry,
      files: [`${contentDir}/manifest.json`, "/cache/v1/k/manifest.json"].sort(),
    });
  });

  test("a commit refuses an output outside its staging dir", async () => {
    const fs = createMemoryFileSystem();
    const refused = async (outside: (stagingDir: string) => string) => {
      const { stagingDir } = await stage(fs, "/cache", { f: "x" });
      await fs.writeText(outside(stagingDir), "x");
      const committing = commitEntry(
        fs,
        "/cache",
        "k",
        stagingDir,
        { out: outside(stagingDir) },
        true,
        NOW,
      );
      return (await refusal(committing)).split(":")[0];
    };
    expect({
      sibling: await refused((dir) => `${dir}/../sibling`),
      elsewhere: await refused(() => "/elsewhere"),
    }).toEqual({
      sibling: "output not under the output dir",
      elsewhere: "output not under the output dir",
    });
  });

  test("a manifest whose outputs are no record, as a bare path or a list once stored, reads as a miss", async () => {
    const fs = createMemoryFileSystem();
    const stored = { bare: "f", list: ["f"] };
    for (const [key, outputs] of Object.entries(stored))
      await fs.writeText(
        `/cache/v1/${key}/manifest.json`,
        JSON.stringify({ outputs, contentHash: "1", outputHashes: {} }),
      );
    expect([
      await lookupEntry(fs, "/cache", "bare", NOW),
      await lookupEntry(fs, "/cache", "list", NOW),
    ]).toEqual([undefined, undefined]);
  });

  test("a read while a manifest is half written sees the old entry, then the new one", async () => {
    const base = createMemoryFileSystem();
    const halfWritten = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const fs: FileSystem = {
      ...base,
      writeText: async (path, content) => {
        await base.writeText(path, content.slice(0, content.length / 2));
        halfWritten.resolve();
        await resume.promise;
        await base.writeText(path, content);
      },
    };
    const commitThrough = async (commitFs: FileSystem, content: string) => {
      const { stagingDir, outputs } = await stage(base, "/cache", { f: content });
      return commitEntry(commitFs, "/cache", "k", stagingDir, outputs, true, NOW);
    };
    const old = await commitThrough(base, "old");
    const writing = commitThrough(fs, "new");
    await halfWritten.promise;
    const during = await lookupEntry(base, "/cache", "k", NOW);
    resume.resolve();
    const next = await writing;
    expect({ during, after: await lookupEntry(base, "/cache", "k", NOW) }).toEqual({
      during: old,
      after: next,
    });
  });

  test("a key keeps the content dir of each content committed under it, one for two commits of the same content, and its manifest names the last; a commit with no manifest writes none", async () => {
    const fs = createMemoryFileSystem();
    const first = await commit(fs, "/cache", "k", { out: "first" });
    const again = await commit(fs, "/cache", "k", { out: "first" });
    const last = await commit(fs, "/cache", "k", { out: "last" });
    const uncached = [
      await commit(fs, "/cache", "u", { out: "1" }, { writeManifest: false }),
      await commit(fs, "/cache", "u", { out: "2" }, { writeManifest: false }),
    ];
    const sorted = async (dir: string) => (await fs.readdir(dir)).sort();
    expect({
      again: again.outputs,
      keyDir: await sorted("/cache/v1/k"),
      found: await lookupEntry(fs, "/cache", "k", NOW),
      uncachedDir: await sorted("/cache/v1/u"),
      uncachedFound: await lookupEntry(fs, "/cache", "u", NOW),
    }).toEqual({
      again: first.outputs,
      keyDir: [first.contentHash, last.contentHash, "manifest.json"].sort(),
      found: last,
      uncachedDir: uncached.map((entry) => entry.contentHash).sort(),
      uncachedFound: undefined,
    });
  });

  test("a cacheDir with a trailing slash is the same directory", async () => {
    const fs = createMemoryFileSystem();
    const entry = await commit(fs, "/cache/", "k", { out: "x" });
    expect({ found: await lookupEntry(fs, "/cache", "k", NOW), out: entry.outputs["out"] }).toEqual(
      {
        found: entry,
        out: `/cache/v1/k/${entry.contentHash}/out`,
      },
    );
  });

  test("an entry hits under a relative or absolute cacheDir and wherever it is copied: its manifest holds paths relative to its content dir, the entry absolute ones", async () => {
    const fs = createNodeFileSystem();
    const tmp = await diskRoot();
    const home = process.cwd();
    const inDir = async <T>(dir: string, run: () => Promise<T>) => {
      await mkdir(dir, { recursive: true });
      process.chdir(dir);
      try {
        return await run();
      } finally {
        process.chdir(home);
      }
    };
    const { stagingDir, committed } = await inDir(`${tmp}/first`, async () => {
      const dir = newStagingDir(fs, "cache");
      const joined = join(dir, "srt");
      const relativePath = relative(process.cwd(), join(dir, "b"));
      await fs.writeText(joined, "subtitles");
      await fs.writeText(relativePath, "b");
      const outputs = { joined, relative: relativePath };
      return {
        stagingDir: dir,
        committed: await commitEntry(fs, "cache", "k", dir, outputs, true, NOW),
      };
    });
    const absolute = await lookupEntry(fs, `${tmp}/first/cache`, "k", NOW);
    const manifest: unknown = JSON.parse(
      await fs.readText(`${tmp}/first/cache/v1/k/manifest.json`),
    );
    // Only the copy is left, so an entry that named the first tree's files would miss.
    await cp(`${tmp}/first`, `${tmp}/restored`, { recursive: true });
    await rm(`${tmp}/first`, { recursive: true });
    const restored = await inDir(`${tmp}/restored`, () => lookupEntry(fs, "cache", "k", NOW));
    const outputsIn = (tree: string) => {
      const dir = `${tmp}/${tree}/cache/v1/k/${committed.contentHash}`;
      return { joined: `${dir}/srt`, relative: `${dir}/b` };
    };
    const anyNumber: unknown = expect.any(Number);
    expect({
      stagingDir: stagingDir.replace(/[0-9a-f-]{36}$/, "<uuid>"),
      manifest,
      outputs: [committed.outputs, absolute?.outputs, restored?.outputs],
    }).toEqual({
      stagingDir: `${tmp}/first/cache/tmp/<uuid>`,
      manifest: {
        outputs: { joined: "srt", relative: "b" },
        contentHash: committed.contentHash,
        outputHashes: committed.outputHashes,
        fileStats: { srt: { size: 9, mtimeMs: anyNumber }, b: { size: 1, mtimeMs: anyNumber } },
      },
      outputs: [outputsIn("first"), outputsIn("first"), outputsIn("restored")],
    });
  });

  test("a commit whose rename keeps failing rejects with the rename's own error", async () => {
    const base = createMemoryFileSystem();
    const fs: FileSystem = {
      ...base,
      rename: async () => {
        throw new Error("EACCES: refused");
      },
    };
    expect(await refusal(commit(fs, "/cache", "k", { out: "x" }))).toBe("EACCES: refused");
  });

  for (const [label, create] of filesystems) {
    test(`${label} fs: a damaged content dir is replaced when two commits of its key race over it, and then hits`, async () => {
      const { fs, cacheDir } = await create();
      const first = await commit(fs, cacheDir, "k", { out: "original" });
      const out = first.outputs["out"];
      if (typeof out !== "string") throw new Error("out is one file");
      await fs.remove(out);
      await fs.writeText(out, "damaged");
      const raced = await Promise.all([
        commit(fs, cacheDir, "k", { out: "original" }),
        commit(fs, cacheDir, "k", { out: "original" }),
      ]);
      expect({
        raced: raced.map((entry) => entry.outputs),
        found: (await lookupEntry(fs, cacheDir, "k", NOW))?.outputs,
        content: await fs.readText(out),
        tmp: await fs.readdir(`${cacheDir}/tmp`),
      }).toEqual({
        raced: [first.outputs, first.outputs],
        found: first.outputs,
        content: "original",
        tmp: [],
      });
    });

    test(`${label} fs: an output with no file rejects the commit, naming the output and its file, and writes no manifest`, async () => {
      const { fs, cacheDir } = await create();
      const unwritten = async (key: string, path: string) => {
        const { stagingDir } = await stage(fs, cacheDir, { "audio.mp3": "mp3" });
        const outputs = { audio: `${stagingDir}/audio.mp3`, thumb: `${stagingDir}/${path}` };
        return {
          refused: await refusal(commitEntry(fs, cacheDir, key, stagingDir, outputs, true, NOW)),
          manifest: await isAt(fs, `${cacheDir}/v1/${key}/manifest.json`),
        };
      };
      const fix = (file: string) =>
        `Write it at \`\${outputDir}/${file}\` before the action returns.`;
      expect({
        beside: await unwritten("beside", "audio.jpg"),
        nested: await unwritten("nested", "art/audio.jpg"),
      }).toEqual({
        beside: {
          refused: `output "thumb" (audio.jpg) was not written. ${fix("audio.jpg")}`,
          manifest: false,
        },
        nested: {
          refused: `output "thumb" (art/audio.jpg) was not written. ${fix("art/audio.jpg")}`,
          manifest: false,
        },
      });
    });

    test(`${label} fs: an output that is a directory${label === "memory" ? "" : " or a symbolic link"} rejects the commit, and a path that cannot be looked at keeps its own error`, async () => {
      const { fs, cacheDir } = await create();
      const refused = async (output: (stagingDir: string) => Promise<string>) => {
        const stagingDir = newStagingDir(fs, cacheDir);
        await fs.ensureDir(stagingDir);
        const out = await output(stagingDir);
        return refusal(commitEntry(fs, cacheDir, "k", stagingDir, { out }, true, NOW));
      };
      const notAFile = (path: string) =>
        `output "out" (${path}) is not a regular file. ` +
        "Return files only, never a directory or a symbolic link.";
      const outside = `${cacheDir}-outside`;
      await fs.writeText(outside, "x");
      const linked =
        label === "memory"
          ? {}
          : {
              link: await refused(async (dir) => {
                await symlink(outside, `${dir}/link`);
                return `${dir}/link`;
              }),
            };
      expect({
        frames: await refused(async (dir) => {
          await fs.ensureDir(`${dir}/frames`);
          return `${dir}/frames`;
        }),
        under: await refused(async (dir) => {
          await fs.writeText(`${dir}/file`, "x");
          return `${dir}/file/inner`;
        }),
        ...linked,
        outsideWritable: ((await fs.lstat(outside)).mode & 0o200) !== 0,
      }).toEqual({
        frames: notAFile("frames"),
        under: "ENOTDIR",
        ...(label !== "memory" && { link: notAFile("link") }),
        outsideWritable: true,
      });
    });

    test(`${label} fs: a committed output loses its write bits alone, so a write to it fails`, async () => {
      const { fs, cacheDir } = await create();
      const { stagingDir, outputs } = await stage(fs, cacheDir, { "run.sh": "echo hi" });
      await fs.chmod(`${stagingDir}/run.sh`, 0o755);
      const entry = await commitEntry(fs, cacheDir, "k", stagingDir, outputs, true, NOW);
      const out = entry.outputs["run.sh"];
      if (typeof out !== "string") throw new Error("run.sh is one file");
      expect({
        mode: (await fs.lstat(out)).mode & 0o777,
        rewrite: await refusal(fs.writeText(out, "echo bye")),
      }).toEqual({ mode: 0o555, rewrite: "EACCES" });
    });

    test(`${label} fs: a lookup hashes the files only when a size or mtime changed, and a manifest without stats is a miss`, async () => {
      const { fs: disk, cacheDir } = await create();
      const hashed: string[] = [];
      const fs: FileSystem = {
        ...disk,
        hashFile: async (path) => (hashed.push(path), disk.hashFile(path)),
      };
      const lookup = async () => {
        hashed.length = 0;
        const found = await lookupEntry(fs, cacheDir, "k", NOW);
        return [found ? "hit" : "miss", hashed.length];
      };
      const entry = await commit(fs, cacheDir, "k", { out: "original" });
      const out = entry.outputs["out"];
      if (typeof out !== "string") throw new Error("out is one file");
      const hit = await lookup();
      await commit(fs, cacheDir, "k", { out: "original" });
      const afterRecommit = await lookup();
      const manifestFile = `${cacheDir}/v1/k/manifest.json`;
      const recorded = await disk.readText(manifestFile);
      const { contentHash, outputHashes } = entry;
      await disk.writeText(
        manifestFile,
        JSON.stringify({ outputs: { out: "out" }, contentHash, outputHashes }),
      );
      const unrecorded = await lookup();
      await disk.writeText(manifestFile, recorded);
      // Past the filesystem's timestamp resolution and the hit's millisecond.
      await Bun.sleep(20);
      await disk.chmod(out, 0o644);
      await disk.writeText(out, "tampered");
      const changed = await lookup();
      await disk.remove(out);
      const gone = await lookup();
      expect({ hit, afterRecommit, unrecorded, changed, gone }).toEqual({
        hit: ["hit", 0],
        afterRecommit: ["hit", 0],
        unrecorded: ["miss", 0],
        changed: ["miss", 1],
        gone: ["miss", 1],
      });
    });

    test(`${label} fs: a hit stamps its manifest's last use as now, and a commit its content dir's, kept copy or not`, async () => {
      const { fs, cacheDir } = await create();
      const committedAt = Date.parse("2026-10-01");
      const hitAt = Date.parse("2026-10-02");
      const keptAt = Date.parse("2026-10-03");
      const entry = await commit(fs, cacheDir, "k", { out: "x" }, { now: committedAt });
      const lastUses = async () => ({
        manifest: (await fs.lstat(`${cacheDir}/v1/k/manifest.json`)).mtimeMs,
        contentDir: (await fs.lstat(`${cacheDir}/v1/k/${entry.contentHash}`)).mtimeMs,
      });
      const committed = await lastUses();
      await lookupEntry(fs, cacheDir, "k", hitAt);
      const hit = await lastUses();
      await commit(fs, cacheDir, "k", { out: "x" }, { now: keptAt });
      const kept = await lastUses();
      expect({ committed: committed.contentDir, hit, kept: kept.contentDir }).toEqual({
        committed: committedAt,
        hit: { manifest: hitAt, contentDir: committedAt },
        kept: keptAt,
      });
    });

    test(`${label} fs: a prune removes key dirs, content dirs no manifest names and tmp entries last used before its time`, async () => {
      const { fs, cacheDir } = await create();
      const [v1, tmp] = [`${cacheDir}/v1`, `${cacheDir}/tmp`];
      const manifestNaming = (contentHash: string) =>
        JSON.stringify({ outputs: { out: "out" }, contentHash, outputHashes: {}, fileStats: {} });
      const files = {
        [`${v1}/stale/manifest.json`]: manifestNaming("a"),
        [`${v1}/stale/a/out`]: "",
        [`${v1}/hit/manifest.json`]: manifestNaming("b"),
        [`${v1}/hit/a/out`]: "",
        [`${v1}/hit/b/out`]: "",
        [`${v1}/committing/manifest.json`]: manifestNaming("a"),
        [`${v1}/committing/a/out`]: "",
        [`${v1}/committing/b/out`]: "",
        [`${v1}/uncacheable/a/out`]: "",
        [`${v1}/uncacheable/b/out`]: "",
        [`${v1}/.DS_Store`]: "",
        [`${tmp}/killed/out`]: "",
        [`${tmp}/running/out`]: "",
      };
      for (const [path, content] of Object.entries(files)) await fs.writeText(path, content);
      const [old, fresh] = [new Date("2026-09-01"), new Date("2026-10-15")];
      const lastUses = {
        [`${v1}/stale/manifest.json`]: old,
        [`${v1}/stale/a`]: old,
        [`${v1}/hit/manifest.json`]: fresh,
        [`${v1}/hit/a`]: old,
        [`${v1}/hit/b`]: old,
        [`${v1}/committing/manifest.json`]: old,
        [`${v1}/committing/a`]: old,
        [`${v1}/committing/b`]: fresh,
        [`${v1}/uncacheable/a`]: old,
        [`${v1}/uncacheable/b`]: fresh,
        [`${v1}/.DS_Store`]: old,
        [`${tmp}/killed`]: old,
        [`${tmp}/running`]: fresh,
      };
      for (const [path, time] of Object.entries(lastUses)) await fs.utimes(path, time, time);
      const pruned = await pruneCache(fs, cacheDir, { unusedSince: Date.parse("2026-10-01") });
      const sorted = async (dir: string) => (await fs.readdir(dir)).sort();
      expect({
        pruned,
        left: {
          v1: await sorted(v1),
          hit: await sorted(`${v1}/hit`),
          committing: await sorted(`${v1}/committing`),
          uncacheable: await sorted(`${v1}/uncacheable`),
          tmp: await sorted(tmp),
        },
      }).toEqual({
        pruned: [`${tmp}/killed`, `${v1}/hit/a`, `${v1}/stale`, `${v1}/uncacheable/a`],
        left: {
          v1: [".DS_Store", "committing", "hit", "uncacheable"],
          hit: ["b", "manifest.json"],
          committing: ["a", "b", "manifest.json"],
          uncacheable: ["b"],
          tmp: ["running"],
        },
      });
    });
  }
});
