import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryLockfile } from "./index.ts";

const refusalOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "taken",
    (e: unknown) => (e instanceof Error && "code" in e ? e.code : e),
  );

test("a held path refuses a second lock, or with retries waits for the release, and the release frees it", async () => {
  const lockfile = createMemoryLockfile({ epochMilliseconds: () => 0 });
  const release = await lockfile.lock("/h/run.json");
  const refused = await refusalOf(lockfile.lock("/h/run.json"));
  let waited = false;
  const waiting = lockfile.lock("/h/run.json", { retries: 100 }).then((next) => {
    waited = true;
    return next;
  });
  await new Promise((r) => setTimeout(r, 10));
  const beforeRelease = waited;
  await release();
  const releaseNext = await waiting;
  const heldByNext = await lockfile.check("/h/run.json", {});
  await releaseNext();
  assert.deepEqual(
    { refused, beforeRelease, heldByNext, held: [...lockfile.held] },
    { refused: "ELOCKED", beforeRelease: false, heldByNext: true, held: [] },
  );
});

test("a live holder's lock never goes stale, a test's held path neither; an abandoned one is free once stale ms have passed, and taken over", async () => {
  let now = 0;
  const lockfile = createMemoryLockfile({ epochMilliseconds: () => now });
  const compromised: string[] = [];
  const options = { stale: 1000, onCompromised: (e: Error) => void compromised.push(e.message) };
  await lockfile.lock("/live", options);
  await lockfile.lock("/killed", options);
  lockfile.held.add("/locks/elsewhere");
  lockfile.abandon("/killed");
  now = 1000;
  const atStale = await lockfile.check("/killed", options);
  now = 1001;
  const checks = {
    live: await lockfile.check("/live", options),
    elsewhere: await lockfile.check("/elsewhere", { ...options, lockfilePath: "/locks/elsewhere" }),
    killed: await lockfile.check("/killed", options),
  };
  await lockfile.lock("/killed", options);
  assert.deepEqual(
    { atStale, checks, compromised, takenOver: await lockfile.check("/killed", options) },
    {
      atStale: true,
      checks: { live: true, elsewhere: true, killed: false },
      compromised: ["Unable to update lock within the stale threshold"],
      takenOver: true,
    },
  );
});

test("a compromised lock is freed and its holder told; the holder's later release rejects with ERELEASED and leaves the next holder's lock alone", async () => {
  const lockfile = createMemoryLockfile({ epochMilliseconds: () => 0 });
  const compromised: string[] = [];
  const release = await lockfile.lock("/run.json", {
    onCompromised: (e) => void compromised.push(e.message),
  });
  lockfile.compromise("/run.json");
  await lockfile.lock("/run.json");
  assert.deepEqual(
    { compromised, laterRelease: await refusalOf(release()), held: [...lockfile.held] },
    { compromised: ["Lock is compromised"], laterRelease: "ERELEASED", held: ["/run.json.lock"] },
  );
});
