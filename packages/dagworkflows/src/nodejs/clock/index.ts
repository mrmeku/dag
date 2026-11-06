import { wallClock } from "@mrmeku/dagraph";
import { setTimeout } from "node:timers/promises";
import type { Clock } from "../../tasks/index.ts";

export function systemClock(): Clock {
  return {
    ...wallClock,
    sleep: (ms, signal) =>
      setTimeout(ms, undefined, { signal }).then(
        () => {},
        () => {},
      ),
  };
}

export { startGlobalTimer } from "@mrmeku/dagraph";
