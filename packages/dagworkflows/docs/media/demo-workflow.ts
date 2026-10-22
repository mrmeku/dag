/** The workflow demo.tape records. The tools are fake-tool.sh, on PATH under their own names. */
import { defineWorkflow } from "@mrmeku/dagworkflows";

export default defineWorkflow({
  schedulerOptions: { concurrencyLimits: { test: 1 } },
  implementation: async (workflow) => {
    const src = await workflow.glob("src/**", "package-lock.json", "tsconfig.json");
    const install = workflow.run({ name: "install", cmd: ["npm", "ci"] });
    const build = workflow.run({
      name: "build",
      cmd: ["tsc", "-p", "tsconfig.build.json"],
      deps: { install },
      inputs: src,
    });
    const typecheck = workflow.run({
      name: "typecheck",
      cmd: ["tsc", "--noEmit"],
      deps: { install },
      inputs: src,
    });
    const lint = workflow.run({
      name: "lint",
      cmd: ["eslint", "src"],
      deps: { install },
      inputs: src,
    });
    const unit = workflow.run({
      name: "test:unit",
      cmd: ["vitest", "run", "unit"],
      deps: { build },
      inputs: src,
      concurrencyGroup: "test",
    });
    const e2e = workflow.run({
      name: "test:e2e",
      cmd: ["vitest", "run", "e2e"],
      deps: { build },
      inputs: src,
      concurrencyGroup: "test",
    });
    workflow.requireAll({ deps: { typecheck, lint, unit, e2e } });
  },
});
