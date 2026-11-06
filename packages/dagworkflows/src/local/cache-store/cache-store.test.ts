import {
  actionsFor,
  execute,
  Graph,
  startGlobalTimer,
  wallClock,
  type FileSystem,
} from "@mrmeku/dagraph";
import { createNodeFileSystem } from "@mrmeku/dagraph/fs/node";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { clockAt, memoryRuntime } from "../../memory/index.ts";
import { createWorktreeCacheStore } from "./index.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "dag-worktrees-")));
after(() => rmSync(root, { recursive: true, force: true }));

/** git in `cwd`, with no configuration but the test's: its output. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
    stdio: "pipe",
  });

/** A clone's main checkout, `main`, and each of `worktrees` beside it. */
function checkouts(...worktrees: string[]) {
  const dir = mkdtempSync(join(root, "clone-"));
  const main = join(dir, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "trunk");
  git(main, "commit", "-q", "--allow-empty", "-m", "first");
  for (const worktree of worktrees)
    git(main, "worktree", "add", "-q", "--detach", `../${worktree}`);
  return (checkout: string) => join(dir, checkout);
}

/** `work` run from `dir`, as the CLI runs from the checkout's root. */
async function from<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(dir);
  try {
    return await work();
  } finally {
    process.chdir(before);
  }
}

const writeFile = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

/** Each file under `dir` with its text, a link with its target unfollowed; none without `dir`. */
function treeOf(dir: string, prefix = ""): Record<string, string> {
  if (!existsSync(dir)) return {};
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return Object.fromEntries(
    entries.flatMap((entry): [string, string][] => {
      const path = join(dir, entry.name);
      const shown = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) return [[shown, `-> ${readlinkSync(path)}`]];
      if (entry.isDirectory()) return Object.entries(treeOf(path, `${shown}/`));
      return [[shown, readFileSync(path, "utf8")]];
    }),
  );
}

const settledYet = (promise: Promise<unknown>) => {
  const state = { settled: false };
  void promise.finally(() => (state.settled = true));
  return state;
};
const aWhile = () => new Promise((resolve) => setTimeout(resolve, 200));

describe("the worktree cache store, what each checkout holds on disk", () => {
  test("a restore in a worktree copies each path that holds nothing from the main checkout, links unfollowed, and keeps what the worktree has; in the main checkout it copies nothing, and a save keeps nothing", async () => {
    const checkout = checkouts("worktree");
    const store = createWorktreeCacheStore(memoryRuntime().lockfile);
    // Run from a directory below the root, as from a package.
    const [main, worktree] = [join(checkout("main"), "pkg"), join(checkout("worktree"), "pkg")];
    for (const dir of [main, worktree]) mkdirSync(dir);
    await from(main, async () => {
      writeFile("out/a.txt", "main's a");
      writeFile("out/sub/b.txt", "main's b");
      symlinkSync("nowhere", "out/link");
      writeFile("kept/a.txt", "main's kept");
    });
    const inMain = await from(main, () => store.restore(["out", "kept"], "k-1", []));
    const inWorktree = await from(worktree, async () => {
      // The run makes its cache dir, empty, before its restore.
      mkdirSync("out/empty", { recursive: true });
      writeFile("kept/own.txt", "the worktree's");
      const source = await store.restore(["out", "kept", "absent", "~/.npm"], "k-1", []);
      const saved = await store.save(["out"], "k-2");
      return {
        source,
        saved,
        out: treeOf("out"),
        kept: treeOf("kept"),
        files: readdirSync(".").sort(),
      };
    });
    assert.deepEqual(
      { inMain, inWorktree },
      {
        inMain: undefined,
        inWorktree: {
          source: checkout("main"),
          saved: false,
          out: { "a.txt": "main's a", link: "-> nowhere", "sub/b.txt": "main's b" },
          kept: { "own.txt": "the worktree's" },
          files: ["kept", "out"],
        },
      },
    );
  });

  test("a restore copies a path that climbs out of the package but not the checkout, and leaves one that climbs out of the checkout, or is absolute, alone", async () => {
    // Deeper than the main checkout, so a climb out of it lands elsewhere than the main's.
    const checkout = checkouts("trees/worktree");
    writeFile(join(checkout("main"), "out/a.txt"), "main's out");
    writeFile(join(checkout("shared"), "a.txt"), "beside the main checkout");
    writeFile(checkout("x"), "beside the main checkout");
    // Where the main checkout would hold the absolute path, were it joined below the package.
    writeFile(join(checkout("main"), "pkg", checkout("abs"), "a.txt"), "main's abs");
    const worktree = join(checkout("trees/worktree"), "pkg");
    mkdirSync(worktree);
    const source = await from(worktree, () =>
      createWorktreeCacheStore(memoryRuntime().lockfile).restore(
        ["../out", "../../shared", "a/../../../x", checkout("abs")],
        "k-1",
        [],
      ),
    );
    assert.deepEqual(
      {
        source,
        out: treeOf(join(checkout("trees/worktree"), "out")),
        besideWorktree: readdirSync(checkout("trees")),
        absolute: existsSync(checkout("abs")),
      },
      {
        source: checkout("main"),
        out: { "a.txt": "main's out" },
        besideWorktree: ["worktree"],
        absolute: false,
      },
    );
  });

  test("a worktree restore keeps cache hits stat-only", async () => {
    const checkout = checkouts("worktree");
    const graph = new Graph<{ fs: FileSystem }>();
    actionsFor<{ fs: FileSystem }>()({
      kind: "written",
      action: async ({ outputDir, ports }) => {
        const out = `${outputDir}/out`;
        await ports.fs.writeText(out, "x");
        // Past the half millisecond, so Node's copy rounds it up and Bun's truncates it.
        utimesSync(out, 1_700_000_000.0007, 1_700_000_000.0007);
        return { out };
      },
    }).addNode(graph, {});
    const disk = createNodeFileSystem();
    const hashed: string[] = [];
    const counting: FileSystem = {
      ...disk,
      hashFile: async (path) => (hashed.push(path), disk.hashFile(path)),
    };
    const run = (fs: FileSystem) =>
      execute(graph, {
        ports: { fs },
        fs,
        cacheDir: "cache",
        clock: wallClock,
        startTimer: startGlobalTimer,
      });
    await from(checkout("main"), () => run(disk));
    const statuses = await from(checkout("worktree"), async () => {
      await createWorktreeCacheStore(memoryRuntime().lockfile).restore(["cache/v1"], "k-1", []);
      return (await run(counting)).map((result) =>
        result.status === "succeeded" && !result.details.actionRan ? "cached" : result.status,
      );
    });
    assert.deepEqual({ statuses, hashed }, { statuses: ["cached"], hashed: [] });
  });

  test("two restores of one path: the second waits for the first's release, then copies nothing", async () => {
    const checkout = checkouts("worktree");
    const { lockfile } = memoryRuntime();
    const store = createWorktreeCacheStore(lockfile);
    await from(checkout("main"), async () => writeFile("out/who", "main"));
    const outcome = await from(checkout("worktree"), async () => {
      const sources = await Promise.all([
        store.restore(["out"], "k-1", []),
        store.restore(["out"], "k-1", []),
      ]);
      return { sources: sources.sort(), out: treeOf("out"), held: [...lockfile.held] };
    });
    assert.deepEqual(outcome, {
      sources: [checkout("main"), undefined],
      out: { who: "main" },
      held: [],
    });
  });

  test("a restore whose lock is lost gets the lock's warning and goes on", async () => {
    const checkout = checkouts("worktree");
    const { lockfile } = memoryRuntime();
    const store = createWorktreeCacheStore({
      check: lockfile.check,
      // Lost as soon as it is taken, as a refresh that finds it taken loses it.
      lock: async (file, opts) => {
        const release = await lockfile.lock(file, opts);
        lockfile.compromise(file);
        return release;
      },
    });
    await from(checkout("main"), async () => writeFile("out/who", "main"));
    const outcome = await from(checkout("worktree"), async () => {
      const warning = new Promise<Error>((resolve) => process.once("warning", resolve));
      const source = await store.restore(["out"], "k-1", []);
      return { source, out: treeOf("out"), warning: (await warning).message };
    });
    assert.deepEqual(outcome, {
      source: checkout("main"),
      out: { who: "main" },
      warning: "the lock on out was lost: Lock is compromised",
    });
  });

  test("a lock its holder abandoned, as a kill leaves it, is taken over once the clock has moved 10,000 ms past the abandon", async () => {
    const checkout = checkouts("worktree");
    let now = 0;
    const { lockfile } = memoryRuntime({ clock: clockAt(() => now) });
    const store = createWorktreeCacheStore(lockfile);
    await from(checkout("main"), async () => writeFile("out/who", "main"));
    const outcome = await from(checkout("worktree"), async () => {
      const compromised: string[] = [];
      await lockfile.lock("out", { onCompromised: (e) => void compromised.push(e.message) });
      lockfile.abandon("out");
      const restoring = store.restore(["out"], "k-1", []);
      const restore = settledYet(restoring);
      now = 10_000;
      await aWhile();
      const settledAtTheStaleness = restore.settled;
      now = 10_001;
      return {
        settledAtTheStaleness,
        source: await restoring,
        out: treeOf("out"),
        compromised,
      };
    });
    assert.deepEqual(outcome, {
      settledAtTheStaleness: false,
      source: checkout("main"),
      out: { who: "main" },
      compromised: ["Unable to update lock within the stale threshold"],
    });
  });
});
