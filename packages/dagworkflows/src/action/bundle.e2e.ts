import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "yaml";
import * as packageIndex from "../index.ts";

const { ACTION_MAIN, ACTION_POST } = process.env;
if (!ACTION_MAIN || !ACTION_POST)
  throw new Error(
    "ACTION_MAIN and ACTION_POST are unset: they name the action's bundled main.js and post.js, " +
      "absolute paths. CI's test:e2e node (dag/scripts/checks.ts) sets them to build:action's " +
      "outputs; by hand, run `bun build src/action/main.ts src/action/post.ts --target=node " +
      "--format=esm --outdir <dir>` in packages/dagworkflows and set them to <dir>/main.js and " +
      "<dir>/post.js.",
  );

const ACTION_YML = join(import.meta.dirname, "..", "..", "action", "action.yml");

/** The inputs action.yml declares, each with its declaration. */
const ACTION_INPUTS = (() => {
  const action: unknown = parse(readFileSync(ACTION_YML, "utf8"));
  const inputs =
    typeof action === "object" && action !== null && "inputs" in action ? action.inputs : {};
  return Object.entries(typeof inputs === "object" && inputs !== null ? inputs : {});
})();

/**
 * The `INPUT_` variables GitHub's runner sets for a step of this action whose `with` gives
 * `workflow: ci.ts` and `given`: one per input action.yml declares, its default when not given,
 * named as the runner and `@actions/core` name them (spaces to underscores, upper case, dashes
 * kept).
 */
function inputVariables(given: Record<string, string>) {
  const inputs: Record<string, string> = { workflow: "ci.ts", ...given };
  return Object.fromEntries(
    ACTION_INPUTS.map(([name, input]: [string, unknown]) => [
      `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`,
      inputs[name] ??
        (typeof input === "object" && input !== null && "default" in input
          ? String(input.default)
          : ""),
    ]),
  );
}

// A regression that leaves a step waiting fails its test here instead of hanging the suite.
const LIMIT = { timeout: 20_000 };

const root = mkdtempSync(join(tmpdir(), "dag-action-"));
const children = new Set<ChildProcess>();
after(() => {
  for (const child of children) child.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

// A published action's dist/ has no node_modules above it, unlike build:action's output dir in a
// checkout: copies in the temp dir find nothing for a bare import the bundle left external.
const dist = join(root, "dist");
mkdirSync(dist);
const mainScript = join(dist, "main.js");
const postScript = join(dist, "post.js");
copyFileSync(ACTION_MAIN, mainScript);
copyFileSync(ACTION_POST, postScript);

interface Job {
  workspace: string;
  runnerTemp: string;
  /** The marker files the workflow's commands touched. */
  marks: () => string[];
}

/**
 * A job's checkout: a git repository holding `workflow` as ci.ts and nothing installed, with a
 * `marks` directory for the workflow's commands to touch, and the runner's temp dir beside it.
 */
function checkout(workflow: string): Job {
  const job = mkdtempSync(join(root, "job-"));
  const workspace = join(job, "workspace");
  const runnerTemp = join(job, "temp");
  mkdirSync(join(workspace, "marks"), { recursive: true });
  mkdirSync(runnerTemp);
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  writeFileSync(join(workspace, "ci.ts"), workflow);
  return {
    workspace,
    runnerTemp,
    marks: () => readdirSync(join(workspace, "marks")).sort(),
  };
}

/** What main prints as it wires, with no cache or artifact service. */
const NOTICES = [
  "::notice title=dag::actions/cache is off: no cache service in this environment",
  "::notice title=dag::actions/upload-artifact is off: no artifact service in this environment",
];

/** A duration as the log prints it, which differs from run to run. */
const DURATION = /\b\d+(?:ms|\.\d+s)\b/g;

/**
 * One script of the action run as GitHub's runner runs a JavaScript action's step: node on it in
 * the workspace, with the runner's variables, the action's inputs and a step summary file of its
 * own, and none of the variables that reach the cache or artifact service.
 */
function step(script: string, { workspace, runnerTemp }: Job, given: Record<string, string> = {}) {
  const summaryFile = join(runnerTemp, `${basename(script, ".js")}-summary.md`);
  writeFileSync(summaryFile, "");
  const child = spawn(process.execPath, [script], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH,
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "o/r",
      GITHUB_REF: "refs/heads/main",
      GITHUB_WORKSPACE: workspace,
      GITHUB_STEP_SUMMARY: summaryFile,
      RUNNER_TEMP: runnerTemp,
      ...inputVariables(given),
    },
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return {
    interrupt: () => child.kill("SIGINT"),
    ended: new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stdout: string[];
      stderr: string[];
      summary: string;
    }>((resolve) =>
      child.on("close", (code, signal) => {
        children.delete(child);
        resolve({
          code,
          signal,
          stdout: stdout.replace(DURATION, "<time>").split("\n"),
          stderr: stderr.split("\n"),
          summary: readFileSync(summaryFile, "utf8"),
        });
      }),
    ),
  };
}

/** Resolves once `path` exists, or rejects after 10 s. */
async function untilExists(path: string) {
  for (let tries = 0; !existsSync(path); tries++) {
    if (tries === 500) throw new Error(`${path} never appeared`);
    await delay(20);
  }
}

/**
 * A workflow file whose implementation runs `statements`, and whose step summary is a line per
 * node, so a test can read it whole.
 */
const workflowOf = (statements: string) => `import { defineWorkflow } from "@mrmeku/dagworkflows";
export default defineWorkflow({
  implementation: (workflow) => { ${statements} },
  summary: [({ nodes }) => nodes.map(({ node, result }) => \`- \${node.name}: \${result.status}\`)],
});
`;

/** A workflow whose `up:db` owes the post `down:db`, `release`, and whose `e2e` runs until stopped. */
const owingAPost = (release: string) =>
  workflowOf(`
    const db = workflow.task({
      name: "up:db",
      shell: "touch marks/up",
      post: { name: "down:db", shell: ${JSON.stringify(release)} },
    });
    workflow.task({ name: "e2e", deps: { db }, shell: "touch marks/e2e && sleep 30" });
  `);

describe("the action's bundle under GitHub's runner", () => {
  test("main runs on the bundled toolkit, and post owing nothing is silent", LIMIT, async () => {
    const job = checkout(
      workflowOf(`
        const build = workflow.task({ name: "build", shell: "echo built" });
        workflow.task({ name: "test", deps: { build }, shell: "echo tested" });
      `),
    );
    const main = await step(mainScript, job).ended;
    const post = await step(postScript, job).ended;
    assert.deepEqual(
      { main, post },
      {
        main: {
          code: 0,
          signal: null,
          stdout: [
            ...NOTICES,
            "::group::ci.ts · ref=refs/heads/main · 2 nodes",
            "build",
            "test",
            "::endgroup::",
            "▷ build",
            "::group::✔︎ build (<time>)",
            "built",
            "::endgroup::",
            "▷ test",
            "::group::✔︎ test (<time>)",
            "tested",
            "::endgroup::",
            "",
            "✔︎ all 2 nodes succeeded · ci.ts · built 2 · cached 0 · failed 0 · skipped 0 · wall <time>",
            "",
          ],
          stderr: [""],
          summary: "## ci.ts\n\n- build: succeeded\n- test: succeeded\n",
        },
        post: { code: 0, signal: null, stdout: [""], stderr: [""], summary: "" },
      },
    );
  });

  test("a cancel exits main 130, and post pays the post step it left", LIMIT, async () => {
    const job = checkout(owingAPost("touch marks/down"));
    const main = step(mainScript, job);
    await untilExists(join(job.workspace, "marks", "e2e"));
    main.interrupt();
    const { code } = await main.ended;
    const afterMain = job.marks();
    const post = await step(postScript, job).ended;
    assert.deepEqual(
      { main: { code, marks: afterMain }, post: { ...post, marks: job.marks() } },
      {
        main: { code: 130, marks: ["e2e", "up"] },
        post: {
          code: 0,
          signal: null,
          stdout: [
            "::group::post · 1 of 1 post steps owed",
            "down:db",
            "::endgroup::",
            "▷ down:db",
            "::group::✔︎ down:db (<time>)",
            "::endgroup::",
            "",
            "✔︎ 1 node succeeded · ci.ts · post · built 1 · cached 0 · failed 0 · skipped 0 · wall <time>",
            "",
          ],
          stderr: [""],
          summary: "## ci.ts · post\n\n- down:db: succeeded\n",
          marks: ["down", "e2e", "up"],
        },
      },
    );
  });

  test(
    "cache-dir and history-dir place both scripts' cache dir and history, empty meaning the default",
    LIMIT,
    async () => {
      /** What the workspace holds beside the checkout, and what `.dag` holds. */
      const layout = ({ workspace }: Job) => ({
        workspace: readdirSync(workspace)
          .filter((name) => ![".git", "ci.ts", "marks"].includes(name))
          .sort(),
        dag: readdirSync(join(workspace, ".dag")).sort(),
      });
      const dirs = { "cache-dir": "c", "history-dir": "h" };
      const given = checkout(owingAPost("touch marks/down"));
      const main = step(mainScript, given, dirs);
      await untilExists(join(given.workspace, "marks", "e2e"));
      main.interrupt();
      await main.ended;
      await step(postScript, given, dirs).ended;
      const empty = checkout(
        workflowOf(`workflow.task({ name: "build", shell: "touch marks/build" });`),
      );
      await step(mainScript, empty, { "cache-dir": "", "history-dir": "" }).ended;
      assert.deepEqual(
        { given: { ...layout(given), marks: given.marks() }, empty: layout(empty) },
        {
          given: {
            workspace: [".dag", "c", "h"],
            dag: ["durations"],
            marks: ["down", "e2e", "up"],
          },
          empty: { workspace: [".dag"], dag: ["cache", "durations", "history"] },
        },
      );
    },
  );

  test("post installs no signal handling: a SIGINT ends it at once", LIMIT, async () => {
    // The release writes its shell's pid, its process group's, so the test can end the sleep the
    // killed post leaves behind.
    const job = checkout(owingAPost("echo $$ > marks/pid && touch marks/down && sleep 30"));
    const main = step(mainScript, job);
    await untilExists(join(job.workspace, "marks", "e2e"));
    main.interrupt();
    await main.ended;
    const post = step(postScript, job);
    await untilExists(join(job.workspace, "marks", "down"));
    post.interrupt();
    const { code, signal } = await post.ended;
    assert.deepEqual({ code, signal }, { code: null, signal: "SIGINT" });
    process.kill(-Number(readFileSync(join(job.workspace, "marks", "pid"), "utf8")), "SIGKILL");
  });

  test("an escaping error is printed to stderr and fails the step", LIMIT, async () => {
    const job = checkout("export const unrelated = 1;\n");
    const outcome = async (script: string) => {
      const { code, stdout, stderr } = await step(script, job).ended;
      return { code, stdout, error: stderr[0] };
    };
    const refused = {
      code: 1,
      stdout: [""],
      error: "Error: ci.ts default-exports no workflow: export default defineWorkflow({ ... })",
    };
    assert.deepEqual(
      { main: await outcome(mainScript), post: await outcome(postScript) },
      { main: refused, post: refused },
    );
  });

  test("force refused unless a YAML boolean, by both scripts", LIMIT, async () => {
    const job = checkout(
      workflowOf(`workflow.task({ name: "build", shell: "touch marks/build" });`),
    );
    const outcome = async (script: string) => {
      const { code, stdout, stderr } = await step(script, job, { force: "yes" }).ended;
      return { code, stdout, error: stderr.slice(0, 2) };
    };
    const refusal = [
      'TypeError: Input does not meet YAML 1.2 "Core Schema" specification: force',
      "Support boolean input list: `true | True | TRUE | false | False | FALSE`",
    ];
    assert.deepEqual(
      { main: await outcome(mainScript), post: await outcome(postScript), marks: job.marks() },
      {
        main: { code: 1, stdout: [...NOTICES, ""], error: refusal },
        post: { code: 1, stdout: [""], error: refusal },
        marks: [],
      },
    );
  });

  test("only names nodes between commas, and post ignores it", LIMIT, async () => {
    const job = checkout(
      workflowOf(`
        const db = workflow.task({
          name: "up:db",
          shell: "touch marks/up",
          post: { name: "down:db", shell: "touch marks/down" },
        });
        workflow.task({ name: "e2e", deps: { db }, shell: "touch marks/e2e && sleep 30" });
        workflow.task({ name: "build", shell: "touch marks/build" });
        workflow.task({ name: "lint", shell: "touch marks/lint" });
      `),
    );
    const main = step(mainScript, job, { only: "build,e2e" });
    await untilExists(join(job.workspace, "marks", "build"));
    await untilExists(join(job.workspace, "marks", "e2e"));
    main.interrupt();
    const { code } = await main.ended;
    const afterMain = job.marks();
    // A runner gives both scripts the step's one `with`; post given its own, which excludes
    // down:db, shows it reads none.
    const post = await step(postScript, job, { only: "lint" }).ended;
    assert.deepEqual(
      { main: { code, marks: afterMain }, post: { code: post.code, marks: job.marks() } },
      {
        main: { code: 130, marks: ["build", "e2e", "up"] },
        post: { code: 0, marks: ["build", "down", "e2e", "up"] },
      },
    );
  });

  test("the bundle holds no local display and exports the package index", () => {
    const LOCAL_ONLY = [
      // bun's comment naming each module it inlines, as a path from where it was built
      /^\/\/ \S*\blocal\/(?:terminal|log-files|failures-report|words)\/\S*$/gm,
      /^\/\/ \S*\bnode_modules\/(?:std-env|shlex|string-width|supports-hyperlinks)\/\S*$/gm,
      /\b(?:createLiveRenderer|createFailuresReport|createLogFiles|localRerunCommand)/g,
    ];
    const contentOf = (bundle: string) => ({
      localOnly: [...new Set(LOCAL_ONLY.flatMap((pattern) => bundle.match(pattern) ?? []))],
      // The bundle's last statement, `export { a, b as c }`: importing it would run the entry.
      exports: [
        ...(/export \{([^}]*)\};\s*$/.exec(bundle)?.[1] ?? "").matchAll(/([\w$]+)\s*(?:,|$)/g),
      ]
        .map(([, name]) => name)
        .sort(),
    });
    const expected = { localOnly: [], exports: Object.keys(packageIndex).sort() };
    assert.deepEqual(
      {
        main: contentOf(readFileSync(mainScript, "utf8")),
        post: contentOf(readFileSync(postScript, "utf8")),
      },
      { main: expected, post: expected },
    );
  });
});
