import type { StartTimer } from "@mrmeku/dagraph";
import type { Clock } from "../../tasks/index.ts";

/** A clock that reads its time from `epochMilliseconds` and whose sleep ends at once: `clockAt(() => now)`. */
export function clockAt(epochMilliseconds: () => number = () => 0): Clock {
  return { epochMilliseconds, sleep: async () => {} };
}

/** Deterministic clock: each read advances by `step`, and a sleep ends at once. */
export function steppingClock(start = 0, step = 1000): Clock {
  let t = start - step;
  return clockAt(() => (t += step));
}

/** A `StartTimer` that never fires on its own: `fire()` times out every timer started and not stopped. */
export function manualTimer(): StartTimer & { fire: () => void } {
  const running = new Set<() => void>();
  const startTimer: StartTimer = (_ms, onTimeout) => {
    running.add(onTimeout);
    return () => void running.delete(onTimeout);
  };
  return Object.assign(startTimer, {
    fire: () => {
      const due = [...running];
      running.clear();
      for (const onTimeout of due) onTimeout();
    },
  });
}
