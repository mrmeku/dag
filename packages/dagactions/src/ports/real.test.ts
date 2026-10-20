import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createSh } from "./real.ts";

/** Ignores SIGINT, then touches the file named by its argument so the test knows it is ready. */
const IGNORES_SIGINT = [
  "node",
  "-e",
  "process.on('SIGINT', () => {}); require('fs').writeFileSync(process.argv[1], ''); setInterval(() => {}, 1000)",
];

const until = async (ready: () => boolean) => {
  while (!ready()) await new Promise((r) => setTimeout(r, 20));
};

describe("createSh with a signal", () => {
  test("a cancelled command is interrupted, escalated when it ignores SIGINT, and refused once the signal has fired, each saying so as it streams", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dagactions-sh-"));
    const readyFile = join(dir, "ready");
    try {
      const sh = createSh({ sigintGraceMs: 300, sigtermGraceMs: 300 });
      const controller = new AbortController();
      const streamed: string[] = [];
      const polite = sh.run(["sleep", "30"], {
        signal: controller.signal,
        onOutput: (chunk) => streamed.push(chunk),
      });
      const stubborn = sh.run([...IGNORES_SIGINT, readyFile], { signal: controller.signal });
      await until(() => existsSync(readyFile));
      controller.abort();
      const [a, b] = await Promise.all([polite, stubborn]);
      const lateStreamed: string[] = [];
      const late = await sh.run(["sleep", "30"], {
        signal: controller.signal,
        onOutput: (chunk) => lateStreamed.push(chunk),
      });
      assert.deepEqual(
        {
          polite: [a.ok, a.code, a.stderr, streamed],
          stubborn: [b.ok, b.code, b.stderr],
          late: { ...late, streamed: lateStreamed },
        },
        {
          polite: [false, -1, "killed by SIGINT\n", ["killed by SIGINT\n"]],
          stubborn: [false, -1, "killed by SIGTERM\n"],
          late: {
            code: -1,
            stdout: "",
            stderr: "cancelled before start",
            output: "cancelled before start",
            ok: false,
            streamed: ["cancelled before start"],
          },
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createSh with children", () => {
  test("a cancelled command's children stop with it, in the foreground or in the background, where a job gets SIGTERM to stop cleanly before SIGKILL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dagactions-sh-"));
    try {
      const sh = createSh({ sigintGraceMs: 200, sigtermGraceMs: 200, streamDrainGraceMs: 200 });
      const controller = new AbortController();
      const running = [
        // Waited on in the foreground, as npm run and make do; node resets SIGINT to the default.
        sh.run(
          [
            "sh",
            "-c",
            `node -e "setTimeout(() => require('fs').writeFileSync('${join(dir, "foreground")}', ''), 1000)"; true`,
          ],
          { signal: controller.signal },
        ),
        // Started with &, so it ignores SIGINT, and holding none of the command's output: only
        // what the group gets once the command exits stops it.
        sh.run(["sh", "-c", `(sleep 1; : > ${join(dir, "background")}) >/dev/null 2>&1 & wait`], {
          signal: controller.signal,
        }),
        // A background job that stops cleanly on SIGTERM gets the chance.
        sh.run(
          [
            "sh",
            "-c",
            `(trap ': > ${join(dir, "graceful")}; exit' TERM; sleep 5 & wait) >/dev/null 2>&1 & wait`,
          ],
          { signal: controller.signal },
        ),
        // One that ignores SIGTERM too gets SIGKILL once the grace is out.
        sh.run(
          [
            "sh",
            "-c",
            `(trap '' TERM; sleep 1; : > ${join(dir, "stubborn")}) >/dev/null 2>&1 & wait`,
          ],
          { signal: controller.signal },
        ),
      ];
      await new Promise((r) => setTimeout(r, 300));
      controller.abort();
      await Promise.all(running);
      await new Promise((r) => setTimeout(r, 1200));
      assert.deepEqual(readdirSync(dir), ["graceful"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createSh output", () => {
  test("stdout and stderr keep each stream apart and the order they arrived in, and stream as they arrive", async () => {
    // The pauses let each write reach the parent before the next, as a real tool's lines do.
    const streamed: string[] = [];
    const r = await createSh().run(
      [
        "sh",
        "-c",
        "echo compiling; sleep 0.2; echo 'warning: unused' >&2; sleep 0.2; echo wrote dist",
      ],
      { onOutput: (chunk) => streamed.push(chunk) },
    );
    assert.deepEqual(
      { stdout: r.stdout, stderr: r.stderr, output: r.output, streamed },
      {
        stdout: "compiling\nwrote dist\n",
        stderr: "warning: unused\n",
        output: "compiling\nwarning: unused\nwrote dist\n",
        streamed: ["compiling\n", "warning: unused\n", "wrote dist\n"],
      },
    );
  });
});

describe("createSh with a process left behind", () => {
  test("a command that exits while a background process holds its output settles after the drain grace, with what it printed", async () => {
    const sh = createSh({ streamDrainGraceMs: 200 });
    const started = Date.now();
    const r = await sh.run(["sh", "-c", "sleep 30 & echo $!"]);
    const elapsed = Date.now() - started;
    process.kill(Number(r.stdout.trim()));
    assert.deepEqual(
      {
        ok: r.ok,
        code: r.code,
        printedPid: /^\d+\n$/.test(r.stdout),
        settledEarly: elapsed < 5000,
      },
      { ok: true, code: 0, printedPid: true, settledEarly: true },
    );
  });
});

describe("createSh env", () => {
  test("an undefined value removes an inherited variable; a string sets one", async () => {
    process.env.DAGACTIONS_TEST_INHERITED = "inherited";
    try {
      const r = await createSh().run(
        ["sh", "-c", 'echo "${DAGACTIONS_TEST_INHERITED-unset} ${DAGACTIONS_TEST_SET-unset}"'],
        { env: { DAGACTIONS_TEST_INHERITED: undefined, DAGACTIONS_TEST_SET: "set" } },
      );
      assert.equal(r.stdout, "unset set\n");
    } finally {
      delete process.env.DAGACTIONS_TEST_INHERITED;
    }
  });
});

describe("abortOnSignals", () => {
  test("a second signal exits at once and kills what the running commands started", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dagactions-signals-"));
    const [ready, late] = [join(dir, "ready"), join(dir, "late")];
    // Stops only on a second SIGINT, as a server that shuts down gracefully does; else writes `late`.
    const command = `
      let n = 0;
      process.on("SIGINT", () => ++n === 2 && process.exit(1));
      require("fs").writeFileSync(${JSON.stringify(ready)}, "");
      setTimeout(() => require("fs").writeFileSync(${JSON.stringify(late)}, ""), 1500);
    `;
    const script = `
      import { abortOnSignals, createSh } from ${JSON.stringify(new URL("./real.ts", import.meta.url).pathname)};
      await createSh().run(["node", "-e", ${JSON.stringify(command)}], { signal: abortOnSignals() });
    `;
    try {
      const parent = spawn("node", ["--input-type=module", "-e", script], { stdio: "ignore" });
      const exited = once(parent, "exit");
      await until(() => existsSync(ready));
      parent.kill("SIGINT");
      await new Promise((r) => setTimeout(r, 200));
      parent.kill("SIGINT");
      const [code] = await exited;
      await new Promise((r) => setTimeout(r, 2000));
      assert.deepEqual({ code, late: existsSync(late) }, { code: 130, late: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SIGHUP cancels as SIGINT does, and a process whose terminal is gone still finishes its cleanup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dagactions-signals-"));
    const [ready, done] = [join(dir, "ready"), join(dir, "done")];
    // On abort, the cleanup prints, as a post pass does, then records that it finished and exits.
    const script = `
      import { writeFileSync } from "node:fs";
      import { abortOnSignals } from ${JSON.stringify(new URL("./real.ts", import.meta.url).pathname)};
      abortOnSignals().addEventListener("abort", () => {
        for (let i = 0; i < 100; i++) process.stdout.write("cleaning up\\n");
        setTimeout(() => {
          writeFileSync(${JSON.stringify(done)}, "");
          process.exit(0);
        }, 100);
      });
      writeFileSync(${JSON.stringify(ready)}, "");
      setTimeout(() => {}, 5000);
    `;
    try {
      const child = spawn("node", ["--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = once(child, "exit");
      await until(() => existsSync(ready));
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill("SIGHUP");
      const [code, signal] = await exited;
      assert.deepEqual(
        { code, signal, finished: existsSync(done) },
        { code: 0, signal: null, finished: true },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
