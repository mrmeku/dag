import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryArtifactStore, createMemoryCacheStore } from "../recording/index.ts";
import { clockAt, createTestPorts, okExec } from "./index.ts";

test("with no options: commands that succeed, a stepping clock, a timer that never fires on its own, no environment, and the file system, host and fresh stores it returns", async () => {
  const { ports, fs, rec, cacheStore, artifactStore } = createTestPorts();
  const other = createTestPorts();
  let timedOut = false;
  ports.startTimer(0, () => {
    timedOut = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(
    {
      exec: ports.exec === okExec,
      clock: [ports.clock.epochMilliseconds(), ports.clock.epochMilliseconds()],
      timedOut,
      env: ports.env,
      returned: [
        ports.fs === fs,
        ports.host === rec.host,
        ports.cacheStore === cacheStore,
        ports.artifactStore === artifactStore,
      ],
      fresh: [
        other.fs !== fs,
        other.cacheStore !== cacheStore,
        other.artifactStore !== artifactStore,
      ],
    },
    {
      exec: true,
      clock: [0, 1000],
      timedOut: false,
      env: {},
      returned: [true, true, true, true],
      fresh: [true, true, true],
    },
  );
});

test("files are read through fs, matches answer the file matcher with no disk, and a context overrides only what it gives", async () => {
  const { ports, fs } = createTestPorts({
    files: { "/w/src/a.ts": "a" },
    matches: { "src/**": ["src/a.ts"] },
    context: { runId: 7 },
  });
  assert.deepEqual(
    {
      read: await fs.readText("/w/src/a.ts"),
      match: await ports.fileMatcher.match(["src/**", "package.json"]),
      context: await ports.host.context(),
    },
    {
      read: "a",
      match: ["src/a.ts"],
      context: {
        isCi: false,
        provider: "recording",
        ref: "",
        sha: "",
        eventName: "",
        actor: "",
        runId: 7,
        repo: { owner: "", repo: "" },
        serverUrl: "",
      },
    },
  );
});

test("each option given replaces its port alone", () => {
  const exec = { run: okExec.run };
  const clock = clockAt();
  const env = { CI: "true" };
  const cacheStore = createMemoryCacheStore();
  const artifactStore = createMemoryArtifactStore();
  const portsHolding = (ports: object, value: unknown) =>
    Object.entries(ports).flatMap(([port, held]) => (held === value ? [port] : []));
  assert.deepEqual(
    {
      exec: portsHolding(createTestPorts({ exec }).ports, exec),
      clock: portsHolding(createTestPorts({ clock }).ports, clock),
      env: portsHolding(createTestPorts({ env }).ports, env),
      cacheStore: portsHolding(createTestPorts({ cacheStore }).ports, cacheStore),
      artifactStore: portsHolding(createTestPorts({ artifactStore }).ports, artifactStore),
    },
    {
      exec: ["exec"],
      clock: ["clock"],
      env: ["env"],
      cacheStore: ["cacheStore"],
      artifactStore: ["artifactStore"],
    },
  );
});
