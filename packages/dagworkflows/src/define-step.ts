import { actionsFor } from "@mrmeku/dagraph";
import type { Ports } from "./ports.ts";

/**
 * `defineAction` bound to the runner `Ports`: the bridge between the engine and the steps. Any
 * group passes here, since a workflow checks its steps' groups against its own `concurrencyLimits`.
 */
export const defineStep = actionsFor<Ports, string>();
