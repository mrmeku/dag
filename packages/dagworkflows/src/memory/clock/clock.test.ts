import assert from "node:assert/strict";
import { test } from "node:test";
import { clockAt, manualTimer, steppingClock } from "./index.ts";

test("a stepping clock moves by its step at each read, and a clock reading a function reads it", () => {
  const stepping = steppingClock(100, 10);
  let now = 5;
  const reading = clockAt(() => now);
  const readings = [stepping.epochMilliseconds(), stepping.epochMilliseconds()];
  now = 7;
  assert.deepEqual(
    { stepping: [...readings, stepping.epochMilliseconds()], reading: reading.epochMilliseconds() },
    { stepping: [100, 110, 120], reading: 7 },
  );
});

test("a sleep ends at once, however long it asks for", async () => {
  const clock = steppingClock();
  await Promise.race([
    clock.sleep(60_000),
    new Promise((_, reject) => setTimeout(() => reject(new Error("still asleep")), 100)),
  ]);
});

test("a manual timer fires only when fired, then only the timers started and not stopped, each once", () => {
  const timer = manualTimer();
  const fired: string[] = [];
  timer(30, () => fired.push("a"));
  const stopB = timer(30, () => fired.push("b"));
  stopB();
  timer.fire();
  timer(30, () => fired.push("c"));
  const before = [...fired];
  timer.fire();
  assert.deepEqual({ before, after: fired }, { before: ["a"], after: ["a", "c"] });
});
