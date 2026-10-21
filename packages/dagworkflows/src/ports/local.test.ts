import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalHost } from "./local.ts";
import { createTestPorts } from "./memory.ts";

test("the local summary across processes and passes, without escape codes", async () => {
  const { ports, fs } = createTestPorts({ files: { "s.md": "an earlier process's summary\n" } });
  const lines: string[] = [];
  const host = createLocalHost({
    exec: ports.exec,
    fs,
    summaryPath: "s.md",
    write: (l) => lines.push(l),
  });
  await host.summary("## run\n\x1b[31merror\x1b[0m\n");
  await host.summary("## post\n");
  assert.deepEqual(
    { file: fs.files.get("s.md"), lines },
    { file: "## run\nerror\n## post\n", lines: ["summary: s.md", "summary: s.md"] },
  );
});
