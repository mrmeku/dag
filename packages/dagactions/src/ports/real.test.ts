import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
  test("a cancelled command is interrupted, escalated when it ignores SIGINT, and refused once the signal has fired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dagactions-sh-"));
    const readyFile = join(dir, "ready");
    try {
      const sh = createSh({ sigintGraceMs: 300, sigtermGraceMs: 300 });
      const controller = new AbortController();
      const polite = sh.run(["sleep", "30"], { signal: controller.signal });
      const stubborn = sh.run([...IGNORES_SIGINT, readyFile], { signal: controller.signal });
      await until(() => existsSync(readyFile));
      controller.abort();
      const [a, b] = await Promise.all([polite, stubborn]);
      const late = await sh.run(["sleep", "30"], { signal: controller.signal });
      assert.deepEqual(
        { polite: [a.ok, a.code, a.stderr], stubborn: [b.ok, b.code, b.stderr], late },
        {
          polite: [false, -1, "killed by SIGINT\n"],
          stubborn: [false, -1, "killed by SIGTERM\n"],
          late: {
            code: -1,
            stdout: "",
            stderr: "cancelled before start",
            output: "cancelled before start",
            ok: false,
          },
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createSh output", () => {
  test("stdout and stderr keep each stream apart and the order they arrived in", async () => {
    // The pauses let each write reach the parent before the next, as a real tool's lines do.
    const r = await createSh().run([
      "sh",
      "-c",
      "echo compiling; sleep 0.2; echo 'warning: unused' >&2; sleep 0.2; echo wrote dist",
    ]);
    assert.deepEqual(
      { stdout: r.stdout, stderr: r.stderr, output: r.output },
      {
        stdout: "compiling\nwrote dist\n",
        stderr: "warning: unused\n",
        output: "compiling\nwarning: unused\nwrote dist\n",
      },
    );
  });
});
