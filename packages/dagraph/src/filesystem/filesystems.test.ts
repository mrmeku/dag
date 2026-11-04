import { afterAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import type { FileSystem } from "../cache/index.ts";
import { createBunFileSystem } from "./bun.ts";
import { createMemoryFileSystem } from "./index.ts";
import { createNodeFileSystem } from "./node.ts";

const roots: string[] = [];
afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const diskRoot = async () => {
  const root = await realpath(await mkdtemp(`${tmpdir()}/dagraph-fs-`));
  roots.push(root);
  return root;
};

const filesystems: [string, () => Promise<{ fs: FileSystem; root: string }>][] = [
  ["memory", async () => ({ fs: createMemoryFileSystem(), root: "/root" })],
  ["bun", async () => ({ fs: createBunFileSystem(), root: await diskRoot() })],
  ["node", async () => ({ fs: createNodeFileSystem(), root: await diskRoot() })],
];

/** What a call did: its value, or the code it failed with. */
const outcome = <T>(call: Promise<T>) =>
  call.then(
    (value) => ({ value }),
    (e: unknown) => ({ code: e instanceof Error && "code" in e ? e.code : String(e) }),
  );

test("the memory, bun and node adapters do the same on a directory: an empty one exists, takes a mode and times, and changes its mtime as an entry comes; a file is not renamed onto one, nor read, nor listed as one", async () => {
  const seen = await Promise.all(
    filesystems.map(async ([label, create]) => {
      const { fs, root } = await create();
      const at = (path: string) => `${root}/${path}`;
      await fs.ensureDir(at("empty"));
      await fs.ensureDir(at("moded"));
      await fs.chmod(at("moded"), 0o700);
      await fs.ensureDir(at("timed"));
      const set = new Date(1_000_000);
      await fs.utimes(at("timed"), set, set);
      await fs.writeText(at("timed/entry"), "x");
      await fs.writeText(at("file"), "x");
      await fs.writeText(at("full/entry"), "x");
      return [
        label,
        {
          emptyIsDirectory: await outcome(fs.lstat(at("empty")).then((s) => s.isFile())),
          emptyListsNothing: await outcome(fs.readdir(at("empty"))),
          emptyHasAnMtime: await outcome(fs.lstat(at("empty")).then((s) => s.mtimeMs > 0)),
          modeOfDirectory: await outcome(fs.lstat(at("moded")).then((s) => s.mode & 0o777)),
          entryChangesMtime: await outcome(
            fs.lstat(at("timed")).then((s) => s.mtimeMs !== set.getTime()),
          ),
          utimesOfEmpty: await outcome(
            fs
              .utimes(at("empty"), set, set)
              .then(() => fs.lstat(at("empty")))
              .then((s) => s.mtimeMs),
          ),
          fileOntoDirectory: await outcome(fs.rename(at("file"), at("empty"))),
          directoryOntoFile: await outcome(fs.rename(at("empty"), at("file"))),
          directoryOntoFull: await outcome(fs.rename(at("empty"), at("full"))),
          readDirectory: await outcome(fs.readText(at("full"))),
          listFile: await outcome(fs.readdir(at("file"))),
          ensureOverFile: await outcome(fs.ensureDir(at("file"))),
          ensureUnderFile: await outcome(fs.ensureDir(at("file/below"))),
          renameIntoNothing: await outcome(fs.rename(at("file"), at("absent/file"))),
          fsyncDirectory: await outcome(fs.fsync(at("full"))),
          directoryOntoEmpty: await outcome(
            fs
              .ensureDir(at("vacant"))
              .then(() => fs.rename(at("full"), at("vacant")))
              .then(() => fs.readdir(at("vacant"))),
          ),
        },
      ] as const;
    }),
  );
  const expected = {
    emptyIsDirectory: { value: false },
    emptyListsNothing: { value: [] },
    emptyHasAnMtime: { value: true },
    modeOfDirectory: { value: 0o700 },
    entryChangesMtime: { value: true },
    utimesOfEmpty: { value: 1_000_000 },
    fileOntoDirectory: { code: "EISDIR" },
    directoryOntoFile: { code: "ENOTDIR" },
    directoryOntoFull: { code: "ENOTEMPTY" },
    readDirectory: { code: "EISDIR" },
    listFile: { code: "ENOTDIR" },
    ensureOverFile: { code: "EEXIST" },
    ensureUnderFile: { code: "ENOTDIR" },
    renameIntoNothing: { code: "ENOENT" },
    fsyncDirectory: { value: undefined },
    directoryOntoEmpty: { value: ["entry"] },
  };
  expect(Object.fromEntries(seen)).toEqual({
    memory: expected,
    bun: expected,
    node: expected,
  });
});
