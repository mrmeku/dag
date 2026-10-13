/**
 * This repository's CI as a dagactions workflow. Run it locally with `bun run ci`; the action in
 * .github/workflows/ci.yml runs the same file. The CAS is restored first with actions/cache from
 * the last run on main; the checks (scripts/checks.ts) order after it; the CAS is saved last and
 * only on main, so pull requests read main's entry and never evict it.
 */
import { defineWorkflow } from "@mrmeku/dagactions";
import { addChecks } from "./checks.ts";

export default defineWorkflow({
  limits: { maxParallelism: 4, concurrencyLimits: { test: 2 } },
  build: async (w) => {
    const cas = w.restoreCache({
      name: "restore:cas",
      path: [".dagactions/cas"],
      key: `dagactions-main-${w.ctx.sha}`,
      restoreKeys: ["dagactions-main-"],
    });
    const gate = await addChecks(w, cas);
    if (w.ctx.ref === "refs/heads/main") {
      w.saveCache({ name: "save:cas", cache: cas, deps: { gate: w.optional(gate) } });
    }
    return { cas, gate };
  },
});
