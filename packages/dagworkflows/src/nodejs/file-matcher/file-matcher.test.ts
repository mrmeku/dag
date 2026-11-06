import { hashFiles } from "@actions/glob";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, test } from "node:test";
import { fileMatcher } from "./index.ts";

/** Files in a fresh directory, made relative to the working directory when `here`. */
function tree(files: string[], here: boolean) {
  if (here) mkdirSync(".dag", { recursive: true });
  const dir = mkdtempSync(here ? join(".dag", "glob-test-") : join(tmpdir(), "dag-glob-"));
  for (const path of files) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), path);
  }
  return dir;
}

describe("the @actions/glob file matcher", () => {
  test("a negation leaves out a nested node_modules, a directory pattern matches what is under it, and the hash is hashFiles()'s", async () => {
    const dir = tree(["src/b.ts", "src/a.ts", "pkg/node_modules/dep/index.js", "pkg/x.js"], true);
    try {
      const hash = await fileMatcher.hash([`${dir}/src/**`]);
      assert.deepEqual(
        {
          match: await fileMatcher.match([`${dir}/**`, "!**/node_modules/**"]),
          directory: await fileMatcher.match([`${dir}/src`]),
          none: await fileMatcher.match([`${dir}/docs/**`]),
          hash: hash !== "" && hash === (await hashFiles(`${dir}/src/**`)),
        },
        {
          match: [`${dir}/pkg/x.js`, `${dir}/src/a.ts`, `${dir}/src/b.ts`],
          directory: [`${dir}/src/a.ts`, `${dir}/src/b.ts`],
          none: [],
          hash: true,
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file outside the working directory matches as a ../ path, and hashes as nothing, being outside the workspace", async () => {
    const dir = tree(["a.txt"], false);
    try {
      assert.deepEqual(
        {
          match: await fileMatcher.match([`${dir}/*.txt`]),
          hash: await fileMatcher.hash([`${dir}/*.txt`]),
        },
        { match: [relative(process.cwd(), join(dir, "a.txt"))], hash: "" },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The filter is installed once per process, at the first load, so each case has a process of its own.
  test("loaded with GITHUB_ACTIONS unset, a ::debug:: chunk written to stdout after is dropped and an indented one kept; loaded with it true, both kept", () => {
    const script = `
      const { fileMatcher } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).pathname)});
      await fileMatcher.match(["no-such-dir/**"]);
      process.stdout.write("::debug::x\\n");
      process.stdout.write("  ::debug::y\\n");
      process.stdout.write("plain\\n");
    `;
    const written = (env: Record<string, string>) => {
      const run = spawnSync("node", ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, ...env },
      });
      const mine = ["::debug::x", "  ::debug::y", "plain"];
      return {
        status: run.status,
        stderr: run.stderr,
        lines: run.stdout.split("\n").filter((l) => mine.includes(l)),
      };
    };
    assert.deepEqual(
      { unset: written({}), onGithub: written({ GITHUB_ACTIONS: "true" }) },
      {
        unset: { status: 0, stderr: "", lines: ["  ::debug::y", "plain"] },
        onGithub: { status: 0, stderr: "", lines: ["::debug::x", "  ::debug::y", "plain"] },
      },
    );
  });
});
