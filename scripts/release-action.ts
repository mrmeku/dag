/**
 * Publish one version of the dagworkflows action: `bun scripts/release-action.ts <version> <main>
 * <post> [--dry-run]`. github.com/mrmeku/dagworkflows holds build output only: action.yml,
 * dist/main.js, dist/post.js, README.md and LICENSE. `main` is the latest build, the tag
 * `v<version>` pins one, and the moving tag `v<major>` follows the newest, as actions/checkout@v4
 * does. The push authenticates with the deploy key in ACTION_DEPLOY_KEY, read from the environment
 * so it is never part of a node's command or config, where it would be hashed into a cache key. A
 * dry run pushes to a scratch bare repository instead and prints what it pushed.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ACTION_REPO = "git@github.com:mrmeku/dagworkflows.git";
const ACTION_DIR = "packages/dagworkflows/action";

const [version, main, post, flag] = process.argv.slice(2);
if (!version || !main || !post)
  throw new Error("usage: release-action.ts <version> <main> <post> [--dry-run]");
const dryRun = flag === "--dry-run";
const major = `v${version.split(".")[0]}`;
const tag = `v${version}`;
const identity = [
  "-c",
  "user.name=dagworkflows release",
  "-c",
  "user.email=dagworkflows@users.noreply.github.com",
];

const scratch = mkdtempSync(join(tmpdir(), "dag-release-"));
const env = { ...process.env };
if (process.env.ACTION_DEPLOY_KEY) {
  const key = join(scratch, "deploy_key");
  writeFileSync(key, process.env.ACTION_DEPLOY_KEY.trimEnd() + "\n", { mode: 0o600 });
  env.GIT_SSH_COMMAND = `ssh -i ${key} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
}
const git = (args: string[], cwd = scratch) => {
  const r = spawnSync("git", [...identity, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const shown = `git ${args.join(" ")}`;
  if (r.error) throw r.error;
  if (r.signal) throw new Error(`${shown} was killed by ${r.signal}`);
  if (r.status !== 0) throw new Error(`${shown} exited ${r.status}`);
  return r.stdout.toString().trim();
};

try {
  let remote = ACTION_REPO;
  if (dryRun) {
    remote = join(scratch, "remote.git");
    git(["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  }
  const dir = join(scratch, "checkout");
  git(["clone", "--quiet", remote, dir]);
  if (
    spawnSync("git", ["rev-parse", "--verify", "--quiet", "origin/main"], { cwd: dir }).status === 0
  )
    git(["checkout", "--quiet", "-B", "main", "origin/main"], dir);
  else git(["checkout", "--quiet", "--orphan", "main"], dir);
  spawnSync("git", ["rm", "-rfq", "."], { cwd: dir, stdio: "ignore" });
  cpSync(join(ACTION_DIR, "action.yml"), join(dir, "action.yml"));
  cpSync(join(ACTION_DIR, "README.md"), join(dir, "README.md"));
  cpSync("LICENSE", join(dir, "LICENSE"));
  mkdirSync(join(dir, "dist"));
  cpSync(resolve(main), join(dir, "dist", "main.js"));
  cpSync(resolve(post), join(dir, "dist", "post.js"));
  git(["add", "-A"], dir);
  git(["commit", "--quiet", "--allow-empty", "-m", `dagworkflows ${tag}`], dir);
  git(["tag", "-f", tag], dir);
  git(["tag", "-f", major], dir);
  console.log(git(["show", "--stat", "--format=%h %s", "HEAD"], dir));
  git(["push", "--quiet", "origin", "HEAD:main"], dir);
  git(["push", "--quiet", "--force", "origin", `refs/tags/${tag}`, `refs/tags/${major}`], dir);
  console.log(
    `${dryRun ? "dry run: pushed to a scratch repository" : "pushed"}: main, ${tag}, ${major}`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
