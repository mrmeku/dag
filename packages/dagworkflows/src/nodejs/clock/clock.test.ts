import assert from "node:assert/strict";
import { test } from "node:test";
import { systemClock } from "./index.ts";

test("a sleep lasts its time on the wall clock, and one aborted while it sleeps or before it starts ends early", async () => {
  const clock = systemClock();
  const started = clock.epochMilliseconds();
  await clock.sleep(50);
  const slept = clock.epochMilliseconds() - started;
  const controller = new AbortController();
  const abortedAt = clock.epochMilliseconds();
  const aborted = clock.sleep(60_000, controller.signal);
  controller.abort();
  await aborted;
  await clock.sleep(60_000, AbortSignal.abort());
  const cut = clock.epochMilliseconds() - abortedAt;
  assert.deepEqual(
    { sleptItsTime: slept >= 45 && slept < 1000, endedEarly: cut < 1000 },
    { sleptItsTime: true, endedEarly: true },
  );
});
