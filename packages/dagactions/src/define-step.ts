import { defineAction, type Action, type BaseParams, type Outputs } from "@mrmeku/dagraph";
import type { Ports } from "./ports.ts";

/** `defineAction` pre-bound to the runner `Ports`: the bridge between the engine and the steps. */
export function defineStep<P extends BaseParams, R extends Outputs, I = Record<string, unknown>>(
  spec: Parameters<typeof defineAction<Ports, P, R, I>>[0],
): Action<Ports, P, R> {
  return defineAction(spec);
}
