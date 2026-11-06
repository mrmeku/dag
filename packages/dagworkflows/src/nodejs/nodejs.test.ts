import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("importing the runtime loads no toolkit module and leaves stdout alone, until a match loads @actions/glob", () => {
  // Node's own hooks, so `node` even under `bun test`.
  const script = `
    import { registerHooks } from "node:module";
    const loaded = [];
    registerHooks({
      resolve: (specifier, context, next) => {
        if (specifier.startsWith("@actions/")) loaded.push(specifier);
        return next(specifier, context);
      },
    });
    const write = process.stdout.write;
    const { nodejsRuntime } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).pathname)});
    const imported = { loaded: [...loaded], stdoutPatched: process.stdout.write !== write };
    await nodejsRuntime.fileMatcher.match(["no-such-dir/**"]);
    const matched = { loaded: loaded.includes("@actions/glob"), stdoutPatched: process.stdout.write !== write };
    console.log(JSON.stringify({ imported, matched }));
  `;
  const run = spawnSync("node", ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  const out: unknown = JSON.parse(run.stdout || "null");
  assert.deepEqual(
    { status: run.status, stderr: run.stderr, out },
    {
      status: 0,
      stderr: "",
      out: {
        imported: { loaded: [], stdoutPatched: false },
        matched: { loaded: true, stdoutPatched: true },
      },
    },
  );
});
