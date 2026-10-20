import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
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
const EMPTY = "export default { workflow: async () => {} };\n";
/** A workflow file whose graph `body` builds, with `w`. */
const workflowOf = (body: string) =>
  `import { defineWorkflow } from ${JSON.stringify(join(import.meta.dirname, "workflow.ts"))};
export default defineWorkflow({ build: (w) => { ${body} } });
`;
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
}

// A regression that leaves a run waiting fails its test here instead of hanging the suite.
const LIMIT = { timeout: 10_000 };

const root = mkdtempSync(join(tmpdir(), "dagactions-cli-"));
const children = new Set<ChildProcess>();
after(() => {
  // A run a regression keeps waiting goes with the tests that gave up on it.
  for (const child of children) child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

/**
 * `dagactions <command> ci.ts`, `run` unless given, in a directory of its own holding `workflow`
 * as ci.ts and `files`, with no environment but `env` and no git repository. Each of `interrupts`
 * is a ctrl-c sent once stdout shows its text, after the last one's.
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
  }: Invocation = {},
) {
  const dir = mkdtempSync(join(root, "run-"));
  const given = typeof files === "function" ? files(realpathSync(dir)) : files;
  for (const [path, text] of Object.entries({ "ci.ts": workflow, ...given })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const child = spawn(
    process.execPath,
    [...(tty ? AS_IF_A_TERMINAL : []), CLI, command, "ci.ts", ...args],
    { cwd: dir, env: { PATH: process.env.PATH!, GIT_DIR: join(dir, "no-git"), ...env } },
  );
  children.add(child);
  let stdout = "";
  const waiting = [...interrupts];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    if (waiting.length > 0 && stdout.includes(waiting[0]!)) {
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

describe("dagactions run", () => {
  test("the style picked when none is asked for", LIMIT, async () => {
    const grouped = "▶ ci.ts · 0 nodes";
    const failures = "ci.ts · 0 nodes · report .dagactions/failures.md";
    const live = "ci.ts · 0 nodes · logs .dagactions/logs/";
    const cases: Record<string, Invocation> = {
      pipe: {},
      "agent in a pipe": { env: { CLAUDECODE: "1" } },
      terminal: { tty: true, env: { TERM: "xterm-256color" } },
      "dumb terminal": { tty: true, env: { TERM: "dumb" } },
      "agent in a terminal": { tty: true, env: { CLAUDECODE: "1" } },
      "CI with an agent in a terminal": { tty: true, env: { CI: "true", CLAUDECODE: "1" } },
      "asked for in the environment": { env: { DAGACTIONS_OUTPUT_STYLE: "failures" } },
      "asked for as empty in a terminal": { tty: true, env: { DAGACTIONS_OUTPUT_STYLE: "" } },
      "asked for live under CI": { args: ["--output-style", "live"], env: { CI: "true" } },
    };
    const firstLines = await Promise.all(
      Object.entries(cases).map(async ([name, invocation]) => {
        const { stdout } = await cli(EMPTY, invocation).exited;
        return [name, stripVTControlCharacters(stdout[0]!)];
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
        files: [
          ".dagactions",
          ".dagactions/cas",
          ".dagactions/failures.md",
          "ci.ts",
          "history",
          "s.md",
        ],
      },
    );
  });

  test("a node that fails under --force: the run is forced, and exits 1", LIMIT, async () => {
    const { code, stdout } = await cli(workflowOf('w.run({ name: "lint", cmd: ["false"] });'), {
      args: ["--force"],
    }).exited;
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
          "::notice title=dagactions::actions/cache is off: this step cannot reach the cache service; run dagactions as the action",
          "::notice title=dagactions::actions/upload-artifact is off: this step cannot reach the artifact service; run dagactions as the action",
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
        files: [
          ".dagactions",
          ".dagactions/cas",
          ".dagactions/history",
          "ci.ts",
          "step-summary.md",
        ],
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
      'export default { workflow: async () => { console.log("building"); await new Promise((r) => setTimeout(r, 60_000)); } };\n',
      {
        args: ["--output-style", "failures"],
        files: { ".dagactions/cas/last-run.json": lastRun },
        interrupts: ["building", "cancelling"],
      },
    );
    const { code, stdout } = await run.exited;
    assert.deepEqual(
      {
        code,
        stdout,
        report: run.read(".dagactions/failures.md").split("\n"),
        lastRun: run.read(".dagactions/cas/last-run.json"),
      },
      {
        code: 130,
        stdout: [
          "building",
          "SIGINT: cancelling, waiting for running commands to stop",
          "",
          "◼︎ forced exit · report .dagactions/failures.md",
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
          "Logs: .dagactions/logs/ · summary: .dagactions/summary.md",
          "",
        ],
        lastRun,
      },
    );
  });
});

describe("dagactions post", () => {
  test("a post step a stopped run's history owes that fails exits 1", LIMIT, async () => {
    const workflow = workflowOf(`
      const up = w.run({ name: "up", cmd: ["true"] });
      w.post({ name: "down", main: up, cmd: ["false"], deps: {} });
    `);
    // A stopped run's history: it holds no lock, and names its workflow file by its real path.
    const history = (dir: string) =>
      JSON.stringify({
        workflow: join(dir, "ci.ts"),
        nodes: { up: { status: "done", outputs: {}, contentHash: "" } },
      });
    const { code, stdout } = await cli(workflow, {
      command: "post",
      files: (dir) => ({ ".dagactions/history/stopped.json": history(dir) }),
    }).exited;
    // The banner alone: the lines after it carry timings, and the runner's goldens pin them.
    assert.deepEqual(
      { code, banner: stdout[0] },
      { code: 1, banner: "▶ post · 1 of 1 post steps owed" },
    );
  });
});
