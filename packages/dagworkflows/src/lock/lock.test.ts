import assert from "node:assert/strict";
import { test } from "node:test";
import { lockOptions } from "./index.ts";

test("a lock sits beside its path, unresolved, goes stale after 10 s, and a lost one is a process warning its holder goes on past", async () => {
  const { onCompromised, ...options } = lockOptions("/state/history/run.json");
  const warning = new Promise<Error>((resolve) => process.once("warning", resolve));
  const returned = onCompromised(new Error("Lock is compromised"));
  const emitted = await warning;
  assert.deepEqual(
    { options, returned, warning: { name: emitted.name, message: emitted.message } },
    {
      options: { lockfilePath: "/state/history/run.json.lock", realpath: false, stale: 10_000 },
      returned: undefined,
      warning: {
        name: "Warning",
        message: "the lock on /state/history/run.json was lost: Lock is compromised",
      },
    },
  );
});
