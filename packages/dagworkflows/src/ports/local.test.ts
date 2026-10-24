import { createNodeDagFs } from "@mrmeku/dagraph/fs/node";
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { check, lock } from "proper-lockfile";
import type { Exec } from "../ports.ts";
import { createLocalHost, createWorktreeCacheStore } from "./local.ts";
import { createTestPorts } from "./memory.ts";
import { createExec } from "./real.ts";

test("the local summary across processes and passes, without escape codes", async () => {
  const { ports, fs } = createTestPorts({ files: { "s.md": "an earlier process's summary\n" } });
  const lines: string[] = [];
  const host = createLocalHost({
    exec: ports.exec,
    fs,
    summaryPath: "s.md",
    write: (l) => lines.push(l),
  });
  await host.summary("## run\n\x1b[31merror\x1b[0m\n");
  await host.summary("## post\n");
  assert.deepEqual(
    { file: fs.files.get("s.md"), lines },
    { file: "## run\nerror\n## post\n", lines: ["summary: s.md", "summary: s.md"] },
  );
});

const root = realpathSync(mkdtempSync(join(tmpdir(), "dag-worktrees-")));
after(() => rmSync(root, { recursive: true, force: true }));

/** No git configuration but a checkout's own. */
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

/** git in `cwd`, with no configuration but the test's: its output. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: { PATH: process.env.PATH, ...GIT_ENV },
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

const worktreeStore = () =>
  createWorktreeCacheStore({ exec: createExec(), lockfile: { lock, check } });

test("the local context's ref is the branch's, refs/heads/<branch>, as GitHub's is, and none on a detached HEAD", async () => {
  const checkout = checkouts("detached");
  git(checkout("main"), "config", "user.name", "t");
  const exec = createExec();
  const isolated: Exec = {
    run: (cmd, opts) => exec.run(cmd, { ...opts, env: { ...opts?.env, ...GIT_ENV } }),
  };
  const contextIn = (dir: string) =>
    from(dir, () =>
      createLocalHost({ exec: isolated, fs: createNodeDagFs(), summaryPath: "s.md" }).context(),
    );
  const local = {
    isCi: false,
    provider: "local",
    sha: git(checkout("main"), "rev-parse", "HEAD").trim(),
    eventName: "local",
    actor: "t",
    runId: 0,
    repo: { owner: "", repo: "" },
    serverUrl: "",
  };
  assert.deepEqual(
    { branch: await contextIn(checkout("main")), detached: await contextIn(checkout("detached")) },
    { branch: { ...local, ref: "refs/heads/trunk" }, detached: { ...local, ref: "" } },
  );
});

describe("the local cache store, what each checkout holds on disk", () => {
  test("a restore in a worktree copies each path that holds nothing from the main checkout, links unfollowed, and keeps what the worktree has; in the main checkout it copies nothing, and a save keeps nothing", async () => {
    const checkout = checkouts("worktree");
    const store = worktreeStore();
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
      // The run makes the CAS directory, empty, before its restore.
      mkdirSync("out/empty", { recursive: true });
      writeFile("kept/own.txt", "the worktree's");
      const source = await store.restore(["out", "kept", "absent", "~/.npm"], "k-1", []);
      const saved = await store.save(["out"], "k-2");
      return { source, saved, out: treeOf("out"), kept: treeOf("kept"), files: readdirSync(".") };
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

  test("a restore waits for another's lock on the path, and copies nothing once the holder filled it", async () => {
    const checkout = checkouts("worktree");
    const store = worktreeStore();
    await from(checkout("main"), async () => writeFile("out/who", "main"));
    const outcome = await from(checkout("worktree"), async () => {
      mkdirSync("out");
      const release = await lock("out", { lockfilePath: "out.lock", realpath: false });
      const restore = { settled: false };
      const restoring = store.restore(["out"], "k-1", []).finally(() => (restore.settled = true));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const settledWhileHeld = restore.settled;
      writeFile("out/who", "holder");
      await release();
      return { settledWhileHeld, source: await restoring, out: treeOf("out") };
    });
    assert.deepEqual(outcome, {
      settledWhileHeld: false,
      source: undefined,
      out: { who: "holder" },
    });
  });
});
