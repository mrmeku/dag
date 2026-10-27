import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";

const CLI = join(import.meta.dirname, "cli.ts");
const IMPORT_DEFINE_WORKFLOW = `import { defineWorkflow } from ${JSON.stringify(join(import.meta.dirname, "workflow.ts"))};`;
/** A workflow file whose implementation runs `statements`, with `workflow`. */
const workflowOf = (statements: string) =>
  `${IMPORT_DEFINE_WORKFLOW}
export default defineWorkflow({ implementation: (workflow) => { ${statements} } });
`;
const EMPTY = workflowOf("");
// The CLI tells a terminal from a pipe by `isTTY` alone, which this sets before it looks.
const AS_IF_A_TERMINAL = ["--import", "data:text/javascript,process.stdout.isTTY = true"];

interface Invocation {
  command?: "run" | "post";
  args?: string[];
  env?: Record<string, string>;
  tty?: boolean;
  /** Files beside ci.ts, or a function of the directory's real path that gives them. */
  files?: Record<string, string> | ((dir: string) => Record<string, string>);
  interrupts?: string[];
  /** A git checkout to run in, instead of a directory of its own with no git repository. */
  dir?: string;
}

// A regression that leaves a run waiting fails its test here instead of hanging the suite.
const LIMIT = { timeout: 10_000 };

const root = mkdtempSync(join(tmpdir(), "dag-cli-"));
const children = new Set<ChildProcess>();
after(() => {
  // A run a regression keeps waiting goes with the tests that gave up on it.
  for (const child of children) child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

/**
 * `dag <command> ci.ts`, `run` unless given, in a directory of its own holding `workflow`
 * as ci.ts and `files`, with no environment but `env` and no git repository, or in `dir`. Each
 * of `interrupts` is a ctrl-c sent once stdout shows its text, after the last one's.
 */
function cli(
  workflow: string,
  {
    command = "run",
    args = [],
    env = {},
    tty = false,
    files = {},
    interrupts = [],
    dir: checkout,
  }: Invocation = {},
) {
  const dir = checkout ?? mkdtempSync(join(root, "run-"));
  const given = typeof files === "function" ? files(realpathSync(dir)) : files;
  for (const [path, text] of Object.entries({ "ci.ts": workflow, ...given })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const child = spawn(
    process.execPath,
    [...(tty ? AS_IF_A_TERMINAL : []), CLI, command, "ci.ts", ...args],
    {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        ...(checkout === undefined && { GIT_DIR: join(dir, "no-git") }),
        ...env,
      },
    },
  );
  children.add(child);
  let stdout = "";
  const waiting = [...interrupts];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    const next = waiting[0];
    if (next !== undefined && stdout.includes(next)) {
      waiting.shift();
      child.kill("SIGINT");
    }
  });
  return {
    read: (path: string) => readFileSync(join(dir, path), "utf8"),
    files: () => readdirSync(dir, { recursive: true, encoding: "utf8" }).sort(),
    exited: new Promise<{ code: number | null; signal: string | null; stdout: string[] }>(
      (resolve) =>
        child.on("close", (code, signal) => {
          children.delete(child);
          resolve({ code, signal, stdout: stdout.split("\n") });
        }),
    ),
  };
}

describe("dag run", () => {
  test("the style picked when none is asked for", LIMIT, async () => {
    const grouped = "▶ ci.ts · 0 nodes";
    const failures = "ci.ts · 0 nodes · report .dag/failures.md";
    const live = "ci.ts · 0 nodes · logs .dag/logs/";
    const cases: Record<string, Invocation> = {
      pipe: {},
      "agent in a pipe": { env: { CLAUDECODE: "1" } },
      terminal: { tty: true, env: { TERM: "xterm-256color" } },
      "dumb terminal": { tty: true, env: { TERM: "dumb" } },
      "agent in a terminal": { tty: true, env: { CLAUDECODE: "1" } },
      "CI with an agent in a terminal": { tty: true, env: { CI: "true", CLAUDECODE: "1" } },
      "asked for in the environment": { env: { DAG_OUTPUT_STYLE: "failures" } },
      "asked for as empty in a terminal": { tty: true, env: { DAG_OUTPUT_STYLE: "" } },
      "asked for live under CI": { args: ["--output-style", "live"], env: { CI: "true" } },
    };
    const firstLines = await Promise.all(
      Object.entries(cases).map(async ([name, invocation]) => {
        const { stdout } = await cli(EMPTY, invocation).exited;
        return [name, stripVTControlCharacters(stdout[0] ?? "")];
      }),
    );
    assert.deepEqual(Object.fromEntries(firstLines), {
      pipe: grouped,
      "agent in a pipe": failures,
      terminal: live,
      "dumb terminal": grouped,
      "agent in a terminal": failures,
      "CI with an agent in a terminal": grouped,
      "asked for in the environment": failures,
      "asked for as empty in a terminal": live,
      "asked for live under CI": live,
    });
  });

  test("a history and a summary named without a directory", LIMIT, async () => {
    const run = cli(EMPTY, { args: ["--history-dir", "history", "--summary-file", "s.md"] });
    const { code } = await run.exited;
    assert.deepEqual(
      { code, files: run.files() },
      {
        code: 0,
        files: [".dag", ".dag/cas", ".dag/failures.md", "ci.ts", "history", "s.md"],
      },
    );
  });

  test("a node that fails under --force: the run is forced, and exits 1", LIMIT, async () => {
    const { code, stdout } = await cli(
      workflowOf('workflow.task({ name: "lint", cmd: ["false"] });'),
      { args: ["--force"] },
    ).exited;
    // The banner alone: the lines after it carry timings, and the session goldens pin them.
    assert.deepEqual({ code, banner: stdout[0] }, { code: 1, banner: "▶ ci.ts · 1 node · force" });
  });

  test("on GitHub, GitHub's log and summary, and none of a local run's files", LIMIT, async () => {
    const run = cli(EMPTY, {
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_REF: "refs/heads/main",
        GITHUB_STEP_SUMMARY: "step-summary.md",
      },
      files: { "step-summary.md": "" },
    });
    const { code, stdout } = await run.exited;
    assert.deepEqual(
      { code, stdout, summary: run.read("step-summary.md").split("\n"), files: run.files() },
      {
        code: 0,
        stdout: [
          "::notice title=dag::actions/cache is off: this step cannot reach the cache service; use the action instead of `dag run`",
          "::notice title=dag::actions/upload-artifact is off: this step cannot reach the artifact service; use the action instead of `dag run`",
          "::group::ci.ts · ref=refs/heads/main · 0 nodes",
          "::endgroup::",
          "",
          "✔︎ all 0 nodes succeeded · ci.ts · built 0 · cached 0 · failed 0 · skipped 0 · wall 0ms",
          "",
        ],
        summary: [
          "## ci.ts",
          "",
          "### ✔︎ all 0 nodes succeeded",
          "",
          "built **0** · cached **0** · failed **0** · skipped **0** · wall 0ms",
          "",
        ],
        files: [".dag", ".dag/cas", ".dag/history", "ci.ts", "step-summary.md"],
      },
    );
  });

  test("a ctrl-c while the workflow file is imported ends the process at once", LIMIT, async () => {
    const { exited } = cli(
      'console.log("importing");\nawait new Promise((r) => setTimeout(r, 60_000));\n' + EMPTY,
      { interrupts: ["importing"] },
    );
    assert.deepEqual(await exited, { code: null, signal: "SIGINT", stdout: ["importing", ""] });
  });

  test("a second ctrl-c while the workflow builds its graph", LIMIT, async () => {
    const lastRun = JSON.stringify({ durations: { a: 1200 } });
    const run = cli(
      `${IMPORT_DEFINE_WORKFLOW}\nexport default defineWorkflow({ implementation: async () => { console.log("building"); await new Promise((r) => setTimeout(r, 60_000)); } });\n`,
      {
        args: ["--output-style", "failures"],
        files: { ".dag/cas/last-run.json": lastRun },
        interrupts: ["building", "cancelling"],
      },
    );
    const { code, stdout } = await run.exited;
    assert.deepEqual(
      {
        code,
        stdout,
        report: run.read(".dag/failures.md").split("\n"),
        lastRun: run.read(".dag/cas/last-run.json"),
      },
      {
        code: 130,
        stdout: [
          "building",
          "SIGINT: cancelling, waiting for running commands to stop",
          "",
          "◼︎ forced exit · report .dag/failures.md",
          "",
        ],
        report: [
          "# Failures · ci.ts",
          "",
          "status: interrupted",
          "",
          "A forced exit stopped the run.",
          "",
          "No failures.",
          "",
          "Logs: .dag/logs/ · summary: .dag/summary.md",
          "",
        ],
        lastRun,
      },
    );
  });
});

describe("dag run's cache, what the checkouts hold on disk", () => {
  test(
    "the main checkout's CAS warms a new worktree, and the worktree keeps its own after",
    LIMIT,
    async () => {
      const clone = mkdtempSync(join(root, "clone-"));
      const git = (cwd: string, ...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
          cwd,
          env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
          stdio: "pipe",
        });
      const main = join(clone, "main");
      mkdirSync(main);
      git(main, "init", "-q");
      git(main, "commit", "-q", "--allow-empty", "-m", "first");
      git(main, "worktree", "add", "-q", "--detach", "../worktree");
      // The CAS carry: a cached task, whose entry the main checkout's CAS holds.
      const workflow = workflowOf(`
      const cas = workflow.cache({ name: "cas", path: [".dag/cas"], key: "cas-1" });
      workflow.task({
        name: "build",
        shell: "echo built",
        inputs: { version: "build-v1" },
        deps: { cas: cas.restore },
      });
      cas.save();
    `);
      const logs = async (dir: string) => {
        const run = cli(workflow, { dir });
        const { code, stdout } = await run.exited;
        const build = stdout.find((line) => line.startsWith("▶ ✔︎ build"));
        return {
          code,
          restore: run.read(".dag/logs/restore/cas.log"),
          build: build?.endsWith("(cached)") ? "cached" : build && "built",
          save: run.read(".dag/logs/save/cas.log"),
        };
      };
      const inMain = await logs(main);
      const inWorktree = await logs(join(clone, "worktree"));
      const again = await logs(join(clone, "worktree"));
      const notFound = "Cache not found for input keys: cas-1\n";
      const notSaved = "Cache not saved with key: cas-1\n";
      assert.deepEqual(
        { inMain, inWorktree, again },
        {
          inMain: {
            code: 0,
            restore: notFound,
            build: "built",
            save: notSaved,
          },
          // The run makes .dag/cas empty before its restore, which fills it.
          inWorktree: {
            code: 0,
            restore: `Cache restored from: ${realpathSync(main)}\nRestored: .dag/cas\n`,
            build: "cached",
            save: notSaved,
          },
          // The next run finds the worktree's CAS there, and keeps it.
          again: {
            code: 0,
            restore: `${notFound}Kept, already there: .dag/cas\n`,
            build: "cached",
            save: notSaved,
          },
        },
      );
    },
  );
});

describe("dag post", () => {
  test("a post step a stopped run's history owes that fails exits 1", LIMIT, async () => {
    const workflow = workflowOf(`
      workflow.task({
        name: "up",
        cmd: ["true"],
        post: { name: "down", cmd: ["false"], retry: "once" },
      });
    `);
    // A stopped run's history: it holds no lock, and names its workflow file by its real path.
    const history = (dir: string) =>
      JSON.stringify({
        workflow: join(dir, "ci.ts"),
        started: ["up"],
        results: {
          up: {
            name: "up",
            actionKey: "k",
            status: "done",
            outputs: {},
            contentHash: "",
            outputHashes: {},
            elapsed: 0,
          },
        },
      });
    const { code, stdout } = await cli(workflow, {
      command: "post",
      files: (dir) => ({ ".dag/history/stopped.json": history(dir) }),
    }).exited;
    // The banner alone: the lines after it carry timings, and the runner's goldens pin them.
    assert.deepEqual(
      { code, banner: stdout[0] },
      { code: 1, banner: "▶ post · 1 of 1 post steps owed" },
    );
  });
});
