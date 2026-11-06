import { createMemoryFileSystem } from "@mrmeku/dagraph";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { createExec } from "../../nodejs/index.ts";
import type { Exec } from "../../tasks/index.ts";
import { createLocalHost } from "./index.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "dag-local-host-")));
after(() => rmSync(root, { recursive: true, force: true }));

/** No git configuration but each checkout's own, and no repository above `root`. */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CEILING_DIRECTORIES: dirname(root),
};

/** git in `cwd`, committing as `t`: its output. */
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    env: { PATH: process.env.PATH, ...GIT_ENV },
    encoding: "utf8",
    stdio: "pipe",
  });

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

test("a group as an indented block, an annotation as a tagged line, and the summary across processes and passes, without escape codes", async () => {
  const fs = createMemoryFileSystem({ "out/s.md": "an earlier process's summary\n" });
  const lines: string[] = [];
  const host = createLocalHost({
    exec: createExec(),
    fs,
    env: {},
    summaryPath: "out/s.md",
    write: (line) => lines.push(line),
  });
  host.group("✖︎ lint (1ms)", ["checking", "── error ──"]);
  host.annotate("error", "lint", "lint exited 1");
  host.info("▷ test");
  await host.check({ name: "lint", status: "in_progress" });
  await host.summary("## run\n\x1b[31merror\x1b[0m\n");
  await host.summary("## post\n");
  assert.deepEqual(
    { file: fs.files.get("out/s.md")?.data, lines },
    {
      file: "## run\nerror\n## post\n",
      lines: [
        "▶ ✖︎ lint (1ms)",
        "    checking",
        "    ── error ──",
        "[error] lint: lint exited 1",
        "▷ test",
        "summary: out/s.md",
        "summary: out/s.md",
      ],
    },
  );
});

test("git's context: the branch as refs/heads/<branch>, none on a detached HEAD, HEAD before a first commit, nothing outside git; the actor from git's user.name, else $USER", async () => {
  const main = join(root, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "trunk");
  git(main, "commit", "-q", "--allow-empty", "-m", "first");
  git(main, "worktree", "add", "-q", "--detach", "../detached");
  // The worktree shares the main checkout's configuration.
  git(main, "config", "user.name", "t");
  const fresh = join(root, "fresh");
  mkdirSync(fresh);
  git(fresh, "init", "-q", "-b", "trunk");
  const outside = join(root, "outside");
  mkdirSync(outside);
  const exec = createExec();
  const isolated: Exec = {
    run: (cmd, opts) => exec.run(cmd, { ...opts, env: { ...opts?.env, ...GIT_ENV } }),
  };
  const contextIn = (dir: string) =>
    from(dir, () =>
      createLocalHost({
        exec: isolated,
        fs: createMemoryFileSystem(),
        env: { USER: "dev" },
        summaryPath: "s.md",
      }).context(),
    );
  const local = {
    isCi: false,
    provider: "local",
    eventName: "local",
    actor: "dev",
    runId: 0,
    repo: { owner: "", repo: "" },
    serverUrl: "",
  };
  const sha = git(main, "rev-parse", "HEAD").trim();
  assert.deepEqual(
    {
      branch: await contextIn(main),
      detached: await contextIn(join(root, "detached")),
      fresh: await contextIn(fresh),
      outside: await contextIn(outside),
    },
    {
      branch: { ...local, ref: "refs/heads/trunk", sha, actor: "t" },
      detached: { ...local, ref: "", sha, actor: "t" },
      fresh: { ...local, ref: "refs/heads/trunk", sha: "HEAD" },
      outside: { ...local, ref: "", sha: "" },
    },
  );
});
