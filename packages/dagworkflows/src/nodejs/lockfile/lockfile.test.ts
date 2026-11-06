import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lockfile } from "./index.ts";

test("a second lock of a held path is refused; a lock whose file is older than stale, as a kill leaves it, is free and taken", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-lock-"));
  try {
    const held = join(dir, "held.json");
    const killed = join(dir, "killed.json");
    writeFileSync(held, "");
    writeFileSync(killed, "");
    const release = await lockfile.lock(held, { realpath: false });
    const second = await lockfile.lock(held, { realpath: false }).then(
      () => "taken",
      (e: unknown) => (e instanceof Error && "code" in e ? e.code : e),
    );
    await release();
    // proper-lockfile's lock is a directory; one a killed process left is never refreshed again.
    mkdirSync(`${killed}.lock`);
    const old = new Date(Date.UTC(2020, 0, 1));
    utimesSync(`${killed}.lock`, old, old);
    const options = { realpath: false, stale: 5000 };
    const freeBefore = !(await lockfile.check(killed, options));
    const releaseKilled = await lockfile.lock(killed, options);
    const heldAfter = await lockfile.check(killed, options);
    await releaseKilled();
    assert.deepEqual(
      { second, freeBefore, heldAfter },
      { second: "ELOCKED", freeBefore: true, heldAfter: true },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
