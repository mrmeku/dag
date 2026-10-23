/**
 * This repository's CI as a dagworkflows workflow. Run it locally with `bun run ci`; the action in
 * .github/workflows/ci.yml runs the same file. The CAS is restored first with actions/cache from
 * the last run on main; the checks (scripts/checks.ts) order after it; the CAS is saved last and
 * only on main, so pull requests read main's entry and never evict it.
 */
import { defineWorkflow } from "@mrmeku/dagworkflows";
import { addChecks } from "./checks.ts";

export default defineWorkflow({
  schedulerOptions: { maxParallelism: 4, concurrencyLimits: { test: 2 } },
  implementation: async (workflow) => {
    const cas = workflow.restoreCache({
      name: "restore:cas",
      path: [".dag/cas"],
      key: `dag-main-${workflow.ctx.sha}`,
      restoreKeys: ["dag-main-"],
    });
    const requireAll = await addChecks(workflow, cas);
    if (workflow.ctx.ref === "refs/heads/main") {
      workflow.saveCache({ name: "save:cas", cache: cas });
    }
    return { cas, requireAll };
  },
});
