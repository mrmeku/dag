import { afterAll, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { hashBytes, type FileSystem } from "../cache/index.ts";
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

test("the memory, bun and node adapters do the same with every member on a file: write and read, hash, stat, mode, times, rename, remove, list, flush and resolve", async () => {
  const seen = await Promise.all(
    filesystems.map(async ([label, create]) => {
      const { fs, root } = await create();
      const at = (path: string) => `${root}/${path}`;
      await fs.writeText(at("deep/er/text"), "café");
      await fs.writeText(at("replaced"), "first");
      await fs.writeText(at("replaced"), "second");
      await fs.writeText(at("locked"), "x");
      await fs.chmod(at("locked"), 0o444);
      const set = new Date(2_000_000);
      await fs.writeText(at("timed"), "x");
      await fs.utimes(at("timed"), set, set);
      await fs.writeText(at("from"), "moved");
      await fs.writeText(at("onto"), "overwritten");
      await fs.rename(at("from"), at("onto"));
      await fs.writeText(at("gone/a"), "x");
      await fs.writeText(at("gone/b/c"), "x");
      await fs.remove(at("gone"));
      await fs.writeText(at("listed/file"), "x");
      await fs.ensureDir(at("listed/dir"));
      return [
        label,
        {
          readMadeItsDirectories: await outcome(fs.readText(at("deep/er/text"))),
          readAfterOverwrite: await outcome(fs.readText(at("replaced"))),
          hash: await outcome(fs.hashFile(at("deep/er/text"))),
          stats: await outcome(
            fs.lstat(at("deep/er/text")).then((s) => [s.isFile(), s.size, s.mode & 0o777]),
          ),
          writeReadOnly: await outcome(fs.writeText(at("locked"), "y")),
          modeOfReadOnly: await outcome(fs.lstat(at("locked")).then((s) => s.mode & 0o777)),
          utimes: await outcome(fs.lstat(at("timed")).then((s) => s.mtimeMs)),
          renamedOver: await outcome(fs.readText(at("onto"))),
          renamedFrom: await outcome(fs.lstat(at("from"))),
          renameMissing: await outcome(fs.rename(at("absent"), at("anywhere"))),
          removedDirectory: await outcome(fs.lstat(at("gone"))),
          removeMissing: await outcome(fs.remove(at("absent"))),
          list: await outcome(fs.readdir(at("listed")).then((names) => names.sort())),
          listMissing: await outcome(fs.readdir(at("absent"))),
          readMissing: await outcome(fs.readText(at("absent"))),
          hashMissing: await outcome(fs.hashFile(at("absent"))),
          statMissing: await outcome(fs.lstat(at("absent"))),
          statUnderFile: await outcome(fs.lstat(at("replaced/inner"))),
          fsync: await outcome(fs.fsync(at("replaced"))),
          fsyncMissing: await outcome(fs.fsync(at("absent"))),
          resolveAbsolute: fs.resolve(at("deep/er/text")) === at("deep/er/text"),
        },
      ] as const;
    }),
  );
  const expected = {
    readMadeItsDirectories: { value: "café" },
    readAfterOverwrite: { value: "second" },
    hash: { value: hashBytes("café") },
    stats: { value: [true, 5, 0o644] },
    writeReadOnly: { code: "EACCES" },
    modeOfReadOnly: { value: 0o444 },
    utimes: { value: 2_000_000 },
    renamedOver: { value: "moved" },
    renamedFrom: { code: "ENOENT" },
    renameMissing: { code: "ENOENT" },
    removedDirectory: { code: "ENOENT" },
    removeMissing: { value: undefined },
    list: { value: ["dir", "file"] },
    listMissing: { value: [] },
    readMissing: { code: "ENOENT" },
    hashMissing: { code: "ENOENT" },
    statMissing: { code: "ENOENT" },
    statUnderFile: { code: "ENOTDIR" },
    fsync: { value: undefined },
    fsyncMissing: { code: "ENOENT" },
    resolveAbsolute: true,
  };
  expect(Object.fromEntries(seen)).toEqual({
    memory: expected,
    bun: expected,
    node: expected,
  });
});

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

const codeOf = (write: () => void) => {
  try {
    write();
    return undefined;
  } catch (e) {
    return e instanceof Error && "code" in e ? e.code : e;
  }
};

test("the memory filesystem's synchronous writes are its async ones, done when they return, but make no directory", async () => {
  const fs = createMemoryFileSystem({ "/r/file": "x" });
  fs.ensureDirSync("/r/logs/empty");
  fs.writeFileSync("/r/logs/a.log", "one\n");
  fs.appendFileSync("/r/logs/a.log", "two\n");
  fs.appendFileSync("/r/logs/b.log", "new\n");
  const failures = [
    codeOf(() => fs.writeFileSync("/r/file/under", "y")),
    codeOf(() => fs.ensureDirSync("/r/file")),
    codeOf(() => fs.appendFileSync("/r/nowhere/c.log", "y")),
  ];
  await fs.chmod("/r/logs/b.log", 0o444);
  expect({
    a: await fs.readText("/r/logs/a.log"),
    b: await fs.readText("/r/logs/b.log"),
    logs: (await fs.readdir("/r/logs")).sort(),
    failures,
    readOnly: codeOf(() => fs.appendFileSync("/r/logs/b.log", "z")),
  }).toEqual({
    a: "one\ntwo\n",
    b: "new\n",
    logs: ["a.log", "b.log", "empty"],
    failures: ["ENOTDIR", "EEXIST", "ENOENT"],
    readOnly: "EACCES",
  });
});
