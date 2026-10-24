import xterm from "@xterm/headless";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { LIVE_FRAME_MS } from "../../config.ts";
import type { Exec } from "../../ports.ts";
import { clockAt, createMemorySyncFs, createTestPorts } from "../../ports/memory.ts";
import { runJob } from "../../runner.ts";
import { defineWorkflow, type WorkflowDef } from "../../workflow.ts";
import { createLocalSession } from "../session.ts";
import type { WriteStreams } from "./frame.ts";
import { truncate } from "./live.ts";

/** A terminal of `columns`×`rows` that a run's writes go straight into, as a TTY's do. */
function terminal(columns: number, rows: number) {
  const term = new xterm.Terminal({
    cols: columns,
    rows,
    scrollback: 1000,
    convertEol: true,
    allowProposedApi: true,
  });
  const write = (chunk: string | Uint8Array) => (term.write(chunk), true);
  const streams: WriteStreams = {
    stdout: { write, columns, rows, isTTY: true },
    stderr: { write },
  };
  return {
    streams,
    resize: (columns: number, rows: number) => {
      term.resize(columns, rows);
      Object.assign(streams.stdout, { columns, rows });
    },
    /** The lines scrolled off the top, and the window's, its trailing blank rows dropped. */
    screen: async () => {
      await new Promise<void>((done) => term.write("", done));
      const buffer = term.buffer.active;
      const lines = Array.from({ length: buffer.length }, (_, i) => {
        const line = buffer.getLine(i);
        assert.ok(line, `line ${i}`);
        return line.translateToString(true);
      });
      const window = lines.slice(buffer.baseY);
      while (window.at(-1) === "") window.pop();
      return { scrollback: lines.slice(0, buffer.baseY), window };
    },
  };
}

/** A shell whose commands named in `held` run until the test ends them; any other succeeds. */
function heldExec(held: string[]) {
  const running = new Map<
    string,
    { print: (chunk: string) => void; exit: (code: number) => void }
  >();
  const exec: Exec = {
    run: async (cmd, opts) => {
      const [name] = cmd;
      if (name === undefined || !held.includes(name))
        return { code: 0, stdout: "", stderr: "", output: "", ok: true };
      return new Promise((resolve) => {
        let output = "";
        running.set(name, {
          print: (chunk) => {
            output += chunk;
            opts?.onOutput?.(chunk);
          },
          exit: (code) => resolve({ code, stdout: output, stderr: "", output, ok: code === 0 }),
        });
      });
    },
  };
  const command = (name: string) => {
    const held = running.get(name);
    assert.ok(held, `running command ${name}`);
    return held;
  };
  return { exec, command };
}

/**
 * `def` run as `dag run` runs it in a terminal, its commands each held until the test
 * exits it. `at(ms)` lets the run catch up to `ms` and draws the frame a terminal would see then.
 */
function liveRun(workflowDef: WorkflowDef, held: string[], columns = 40, rows = 12) {
  let now = 0;
  const tty = terminal(columns, rows);
  const { exec, command } = heldExec(held);
  const { ports } = createTestPorts({ exec, clock: clockAt(() => now) });
  const session = createLocalSession(
    {
      ...workflowDef,
      workflowFile: "ci.ts",
      ports,
      casBaseDir: "/cas",
      historyDir: "/history",
    },
    { outputStyle: "live", syncFs: createMemorySyncFs(), streams: tty.streams },
  );
  const job = runJob(session, new EventEmitter());
  return {
    ...tty,
    job,
    print: (name: string, chunk: string) => command(name).print(chunk),
    exit: (name: string, code = 0) => command(name).exit(code),
    at: async (timeMs: number) => {
      now = timeMs;
      await new Promise(setImmediate);
      mock.timers.tick(LIVE_FRAME_MS);
      return await tty.screen();
    },
  };
}

describe("live footer", () => {
  test("truncation counts terminal columns and stops measuring at the width", () => {
    assert.deepEqual(
      {
        fits: truncate("typecheck", 9),
        ascii: truncate("typecheck 4.0s", 10),
        wide: truncate("日本語のログ", 7),
        long: truncate("é".repeat(1_000_000), 5),
      },
      { fits: "typecheck", ascii: "typecheck…", wide: "日本語…", long: "éééé…" },
    );
  });
});

// A test that waits on the run fails when the run never gets there, instead of hanging the suite.
const RUN_TIMEOUT = { timeout: 10_000 };

describe("live terminal", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setInterval"] }));
  afterEach(() => mock.timers.reset());

  test("the footer never shows a warning command as a node's latest line", async () => {
    const run = liveRun(
      defineWorkflow({
        implementation: (workflow) => {
          workflow.task({ name: "lint", cmd: ["lint"], cacheable: false });
        },
      }),
      ["lint"],
    );
    await run.at(0);
    run.print("lint", "checking src\n::warning title=lint::deprecated rule");
    const printing = await run.at(600);
    run.print("lint", "\n");
    const ended = await run.at(700);
    run.exit("lint");
    await run.job;
    assert.deepEqual(
      { printing: printing.window, ended: ended.window },
      {
        printing: [
          "ci.ts · 1 node · logs .dag/logs/",
          "⠦ lint 0.6s  checking src",
          "[0/1] 1 running · ctrl-c cancels",
        ],
        ended: [
          "ci.ts · 1 node · logs .dag/logs/",
          "⠧ lint 0.7s  checking src",
          "[0/1] 1 running · ctrl-c cancels",
        ],
      },
    );
  });

  test("during a build: the footer under the scrollback, a node settling above it", async () => {
    const run = liveRun(
      defineWorkflow({
        schedulerOptions: { maxParallelism: 2 },
        implementation: (workflow) => {
          const lint = workflow.task({ name: "lint", cmd: ["lint"], cacheable: false });
          workflow.task({ name: "typecheck", cmd: ["tsc"], cacheable: false });
          workflow.task({ name: "test", cmd: ["test"], cacheable: false });
          workflow.task({ name: "docs", cmd: ["docs"], deps: { lint }, cacheable: false });
        },
      }),
      ["lint", "tsc", "test", "docs"],
    );
    await run.at(0);
    run.print("lint", "checking src\nsrc/feed.ts ok\n");
    run.print("tsc", "[===   ] 30%\r[====== ] 60%\r");
    const running = await run.at(600);
    run.exit("lint");
    const settled = await run.at(1200);
    const title = ["ci.ts · 4 nodes · logs .dag/logs/"];
    assert.deepEqual(
      { running, settled },
      {
        running: {
          scrollback: [],
          window: [
            ...title,
            "⠦ lint      0.6s  src/feed.ts ok",
            "⠦ typecheck 0.6s  [====== ] 60%",
            "· test      queued: 2/2 running",
            "· docs      waits on lint",
            "[0/4] 2 running · 1 queued · ctrl-c ca…",
          ],
        },
        settled: {
          scrollback: [],
          window: [
            ...title,
            "✔︎ lint      1.2s · 2 lines",
            "⠹ typecheck 1.2s  [====== ] 60%",
            "⠹ docs      0.0s",
            "· test      queued: 2/2 running",
            "[1/4] 2 running · 1 queued · ctrl-c ca…",
          ],
        },
      },
    );
  });

  test(
    "scrollback during a build keeps each line once and no footer row",
    RUN_TIMEOUT,
    async () => {
      const names = Array.from({ length: 8 }, (_, i) => `pkg${i + 1}`);
      const run = liveRun(
        defineWorkflow({
          implementation: (workflow) => {
            workflow.task({ name: "bundle", cmd: ["bundle"], cacheable: false });
            for (const name of names) workflow.task({ name, cmd: [name], cacheable: false });
          },
        }),
        ["bundle", ...names],
        40,
        8,
      );
      await run.at(0);
      run.print("bundle", "bundling\n");
      for (const [i, name] of names.entries()) {
        run.print(name, `ok ${i + 1}\n`);
        if (i % 4 === 0) run.streams.stdout.write(`a stray write ${i + 1}\n`);
        run.exit(name, name === "pkg3" ? 1 : 0);
        await run.at(600 + i * 100);
      }
      const midBuild = await run.at(1500);
      run.exit("bundle");
      await run.job;
      const final = await run.screen();
      const scrollback = [
        "ci.ts · 9 nodes · logs .dag/logs/",
        "a stray write 1",
        "✔︎ pkg1   0.6s · 1 line",
        "✔︎ pkg2   0.7s · 1 line",
        "✖︎ pkg3  exit 1 · 0.8s · 1 line",
        "│ ok 3",
        "├ log    .dag/logs/pkg3.log",
        "├ cmd    pkg3   (cwd .)",
        "└ rerun  npx --no dag run ci.ts --only p",
        "kg3",
      ];
      assert.deepEqual(
        { midBuild, final: [...final.scrollback, ...final.window] },
        {
          midBuild: {
            scrollback,
            window: [
              "✔︎ pkg4   0.9s · 1 line",
              "a stray write 5",
              "✔︎ pkg5   1.0s · 1 line",
              "✔︎ pkg6   1.1s · 1 line",
              "✔︎ pkg7   1.2s · 1 line",
              "✔︎ pkg8   1.3s · 1 line",
              "⠴ bundle 1.5s  bundling",
              "[8/9 ✖︎1] 1 running · ctrl-c cancels",
            ],
          },
          final: [
            ...scrollback,
            "✔︎ pkg4   0.9s · 1 line",
            "a stray write 5",
            "✔︎ pkg5   1.0s · 1 line",
            "✔︎ pkg6   1.1s · 1 line",
            "✔︎ pkg7   1.2s · 1 line",
            "✔︎ pkg8   1.3s · 1 line",
            "✔︎ bundle 1.5s · 1 line",
            "summary: .dag/summary.md",
            "",
            "✖︎ pkg3 failed · ci.ts · wall 1.5s",
            "built 8 · cached 0 · failed 1 · skipped ",
            "0",
            "",
            "✖︎ pkg3   exit 1 · 0.8s · 1 line   .dag/l",
            "ogs/pkg3.log",
            "",
            "rerun    npx --no dag run ci.ts --only p",
            "kg3",
            "report   .dag/failures.md   (hand this t",
            "o an agent)",
            "logs     .dag/logs/",
          ],
        },
      );
    },
  );

  test(
    "a window made narrower, then wider, during a build leaves no row behind",
    RUN_TIMEOUT,
    async () => {
      const run = liveRun(
        defineWorkflow({
          implementation: (workflow) => {
            workflow.task({ name: "lint", cmd: ["lint"], cacheable: false });
            workflow.task({ name: "typecheck", cmd: ["tsc"], cacheable: false });
          },
        }),
        ["lint", "tsc"],
        60,
        12,
      );
      await run.at(0);
      run.print("lint", "linting src/settings/notifications/email-digest.ts\n");
      run.print("tsc", "checking 412 files\n");
      await run.at(600);
      run.resize(30, 12);
      const narrowed = await run.at(700);
      run.resize(50, 12);
      const widened = await run.at(800);
      run.exit("lint");
      run.exit("tsc");
      await run.job;
      assert.deepEqual(
        { narrowed: narrowed.window, widened: widened.window, final: (await run.screen()).window },
        {
          narrowed: [
            "ci.ts · 2 nodes · logs .dag/lo",
            "gs/",
            "⠧ lint      0.7s  linting sr…",
            "⠧ typecheck 0.7s  checking 4…",
            "[0/2] 2 running · ctrl-c can…",
          ],
          widened: [
            "ci.ts · 2 nodes · logs .dag/logs/",
            "⠇ lint      0.8s  linting src/settings/notificat…",
            "⠇ typecheck 0.8s  checking 412 files",
            "[0/2] 2 running · ctrl-c cancels",
          ],
          final: [
            "ci.ts · 2 nodes · logs .dag/logs/",
            "✔︎ lint      0.8s · 1 line",
            "✔︎ typecheck 0.8s · 1 line",
            "summary: .dag/summary.md",
            "",
            "✔︎ all 2 nodes succeeded · ci.ts · wall 0.8s",
            "built 2 · cached 0 · failed 0 · skipped 0",
            "",
            "logs     .dag/logs/",
          ],
        },
      );
    },
  );
});
