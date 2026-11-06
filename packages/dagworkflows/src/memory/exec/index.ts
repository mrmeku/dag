import type { Exec } from "../../tasks/index.ts";

/** An Exec where every command succeeds silently. */
export const okExec: Exec = {
  run: async () => ({ ended: "exited", code: 0, stdout: "", stderr: "", output: "", ok: true }),
};
