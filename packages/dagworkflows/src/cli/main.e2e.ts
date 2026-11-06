/**
 * The packed CLI, end to end: npm installs the tarballs of `scripts/pack.ts` into scratch git
 * repositories, and each case runs the `dag` bin npm linked there on a workflow file that imports
 * `@mrmeku/dagworkflows`, as a consumer's does.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { promisify, stripVTControlCharacters } from "node:util";

const { DAGRAPH_TARBALL, DAGWORKFLOWS_TARBALL } = process.env;
if (!DAGRAPH_TARBALL || !DAGWORKFLOWS_TARBALL)
  throw new Error(
    "main.e2e.ts needs DAGRAPH_TARBALL and DAGWORKFLOWS_TARBALL, the absolute paths of the tarballs " +
      "`bun scripts/pack.ts <package> <version> <out dir>` writes; CI's end-to-end node sets them " +
      "from its pack:dagraph and pack:dagworkflows deps",
  );
const tarballs = [DAGRAPH_TARBALL, DAGWORKFLOWS_TARBALL];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const manifest: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"),
);
const peerDependencies =
  isRecord(manifest) && isRecord(manifest.peerDependencies) ? manifest.peerDependencies : {};
/** `name` at the range the package names it as a peer. */
const peer = (name: string) => {
  const range = peerDependencies[name];
  if (typeof range !== "string") throw new Error(`dagworkflows names no peer ${name}`);
  return `${name}@${range}`;
};

const WORKFLOW = `import { defineWorkflow } from "@mrmeku/dagworkflows";

export default defineWorkflow({
  implementation: (workflow) => {
    const cache = workflow.cache({ name: "cache-dir", key: "cache-dir-1" });
    workflow.task({
      name: "build",
      shell: "echo built",
      inputs: { version: "v1" },
      deps: { cache: cache.restore },
    });
    cache.save();
  },
});
`;
const CACHE_NOTICE =
  "actions/cache is off: this step cannot reach the cache service; use the action instead of `dag run`";
const ARTIFACT_NOTICE =
  "actions/upload-artifact is off: this step cannot reach the artifact service; use the action instead of `dag run`";
const MISS = "Cache not found for input keys: cache-dir-1";
const NOT_SAVED = "Cache not saved with key: cache-dir-1";
/** What `@actions/github`'s context needs, beside the variable that chooses the platform. */
const ON_GITHUB = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "o/r",
  GITHUB_REF: "refs/heads/main",
};
// The CLI tells a terminal from a pipe by `isTTY` alone, which this sets before it looks.
const AS_IF_A_TERMINAL = "--import=data:text/javascript,process.stdout.isTTY=true";
// npm resolves from the registry: a slow one is not a regression.
const INSTALL_LIMIT = { timeout: 180_000 };
const LIMIT = { timeout: 30_000 };

const root = mkdtempSync(join(tmpdir(), "dag-cli-e2e-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** A scratch git repository on `main` holding ci.ts, with the tarballs and `peers` installed. */
async function checkout(name: string, peers: string[]) {
  const dir = join(root, name);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true, type: "module" }));
  writeFileSync(join(dir, "ci.ts"), WORKFLOW);
  // No install script runs: this process's environment holds the CI job's tokens.
  await promisify(execFile)(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--loglevel=error",
      ...tarballs,
      ...peers,
    ],
    { cwd: dir },
  );
  return dir;
}

// `bare` has no peer installed but `@actions/core`, which `@actions/glob`, a dependency, brings.
let bare = "";
let toolkit = "";
before(async () => {
  [bare, toolkit] = await Promise.all([
    checkout("bare", []),
    checkout("toolkit", [peer("@actions/core"), peer("@actions/github")]),
  ]);
}, INSTALL_LIMIT);

/**
 * `dag run ci.ts` and `args` in `dir` with no `.dag` from an earlier case, through the bin npm
 * linked, with no environment but `env` and a PATH whose `node` is the one running this file:
 * std-env reads dozens of variables as CI, so the child gets none of this process's.
 */
function dagRun(dir: string, args: string[] = [], env: Record<string, string> = {}) {
  rmSync(join(dir, ".dag"), { recursive: true, force: true });
  const { status, stdout, stderr } = spawnSync(
    join(dir, "node_modules", ".bin", "dag"),
    ["run", "ci.ts", ...args],
    {
      cwd: dir,
      env: { PATH: [dirname(process.execPath), process.env.PATH].join(delimiter), ...env },
      encoding: "utf8",
      timeout: LIMIT.timeout,
    },
  );
  return { code: status, stdout: stdout.split("\n"), stderr: stderr.split("\n") };
}

/** What GitHub's log shows in `node`'s group: the lines it printed. */
function groupOf(stdout: string[], node: string) {
  const start = stdout.findIndex(
    (line) => line.startsWith("::group::") && line.split(" ")[1] === node,
  );
  return stdout.slice(start + 1, stdout.indexOf("::endgroup::", start));
}

/** A run's code, notices, and what its cache's restore and save printed in GitHub's log. */
function onGithub({ code, stdout }: ReturnType<typeof dagRun>) {
  return {
    code,
    notices: stdout.filter((line) => line.startsWith("::notice")),
    restore: groupOf(stdout, "restore:cache-dir"),
    save: groupOf(stdout, "save:cache-dir"),
  };
}

test(
  "dag run under an agent on a terminal, DAG_OUTPUT_STYLE empty: the failures style",
  LIMIT,
  () => {
    const terminal = { TERM: "xterm-256color", NODE_OPTIONS: AS_IF_A_TERMINAL };
    const agent = dagRun(bare, [], { ...terminal, DAG_OUTPUT_STYLE: "", CLAUDECODE: "1" });
    // The same terminal without the agent: live, so the terminal is one.
    const person = dagRun(bare, [], { ...terminal, DAG_OUTPUT_STYLE: "" });
    assert.deepEqual(
      {
        agent: {
          code: agent.code,
          banner: agent.stdout[0],
          style: agent.stdout.find((line) => line.startsWith("style:")),
        },
        person: stripVTControlCharacters(person.stdout[0] ?? ""),
      },
      {
        agent: {
          code: 0,
          banner: "ci.ts · ref=refs/heads/main · 3 nodes · report .dag/failures.md",
          style: "style: failures · every node's log inline: --output-style=grouped",
        },
        person: "ci.ts · ref=refs/heads/main · 3 nodes · logs .dag/logs/",
      },
    );
  },
);

test("DAG_OUTPUT_STYLE=fancy is refused by the parser, on GitHub too", LIMIT, () => {
  const refused = (env: Record<string, string>) => {
    const { code, stderr } = dagRun(bare, [], { ...env, DAG_OUTPUT_STYLE: "fancy" });
    return { code, stderr };
  };
  const refusal = {
    code: 1,
    stderr: [
      "error: option '--output-style <style>' value 'fancy' from env 'DAG_OUTPUT_STYLE' is invalid. Allowed choices are live, failures, grouped.",
      "",
    ],
  };
  assert.deepEqual(
    { local: refused({}), github: refused(ON_GITHUB) },
    { local: refusal, github: refusal },
  );
});

test(
  "dag run in a run: step without @actions/cache or a cache variable: the cache off, with its notice",
  LIMIT,
  () => {
    assert.deepEqual(onGithub(dagRun(toolkit, [], ON_GITHUB)), {
      code: 0,
      notices: [`::notice title=dag::${CACHE_NOTICE}`, `::notice title=dag::${ARTIFACT_NOTICE}`],
      restore: [MISS],
      save: [NOT_SAVED],
    });
  },
);

test("--cache-store none on GitHub loads no @actions/cache and announces nothing", LIMIT, () => {
  // A cache variable has the platform's own store load @actions/cache, which is not installed.
  const env = { ...ON_GITHUB, ACTIONS_CACHE_URL: "http://127.0.0.1:9/" };
  const detected = dagRun(toolkit, [], env);
  assert.deepEqual(
    {
      none: onGithub(dagRun(toolkit, ["--cache-store", "none"], env)),
      detected: {
        code: detected.code,
        refusal: detected.stderr.find((line) => line.startsWith("Error: ")),
      },
    },
    {
      none: {
        code: 0,
        notices: [`::notice title=dag::${ARTIFACT_NOTICE}`],
        restore: [MISS],
        save: [NOT_SAVED],
      },
      detected: {
        code: 1,
        refusal:
          "Error: dag needs @actions/cache on GitHub, an optional peer dependency it does not install: add it (npm install --save-dev @actions/cache), or use the action, which bundles it, instead of `dag run`",
      },
    },
  );
});

test(
  "--cache-store github-actions locally, without the toolkit: the notice and misses, no refusal",
  LIMIT,
  () => {
    const { code, stdout } = dagRun(bare, ["--cache-store", "github-actions"]);
    const log = (path: string) => readFileSync(join(bare, ".dag", "logs", path), "utf8");
    assert.deepEqual(
      {
        code,
        notices: stdout.filter((line) => line.startsWith("[notice]")),
        restore: log("restore/cache-dir.log"),
        save: log("save/cache-dir.log"),
      },
      {
        code: 0,
        notices: [`[notice] dag: ${CACHE_NOTICE}`],
        restore: `${MISS}\n`,
        save: `${NOT_SAVED}\n`,
      },
    );
  },
);
