/** The workflow demo.tape records. The tools are fake-tool.sh, on PATH under their own names. */
import { defineWorkflow } from "@mrmeku/dagworkflows";

export default defineWorkflow({
  schedulerOptions: { concurrencyLimits: { test: 1 } },
  implementation: (workflow) => {
    const install = workflow.run({ name: "install", cmd: ["npm", "ci"] });
    const build = workflow.run({
      name: "build",
      cmd: ["tsc", "-p", "tsconfig.build.json"],
      deps: { install },
    });
    const checks = workflow.runAll({
      typecheck: { cmd: ["tsc", "--noEmit"], deps: { install } },
      lint: { cmd: ["eslint", "src"], deps: { install } },
      "test:unit": { cmd: ["vitest", "run", "unit"], deps: { build }, group: "test" },
      "test:e2e": { cmd: ["vitest", "run", "e2e"], deps: { build }, group: "test" },
    });
    workflow.requireAll({ deps: checks });
  },
});
