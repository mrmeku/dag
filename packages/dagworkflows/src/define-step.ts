import { actionsFor } from "@mrmeku/dagraph";
import type { Ports } from "./ports.ts";

/** `defineAction` bound to the runner `Ports`: the bridge between the engine and the steps. */
export const defineStep = actionsFor<Ports>();
