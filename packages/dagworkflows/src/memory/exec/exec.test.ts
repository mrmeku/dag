import assert from "node:assert/strict";
import { test } from "node:test";
import { okExec } from "./index.ts";

test("every command exits 0 and prints nothing", async () => {
  const streamed: string[] = [];
  const result = await okExec.run(["false"], { onOutput: (chunk) => streamed.push(chunk) });
  assert.deepEqual(
    { result, streamed },
    {
      result: { ended: "exited", code: 0, stdout: "", stderr: "", output: "", ok: true },
      streamed: [],
    },
  );
});
