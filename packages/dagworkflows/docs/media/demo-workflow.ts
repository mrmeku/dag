/** The workflow demo.tape records. The tools are fake-tool.sh, on PATH under their own names. */
import { defineWorkflow } from "@mrmeku/dagworkflows";

export default defineWorkflow({
  schedulerOptions: { concurrencyLimits: { test: 1 } },
  implementation: async (workflow) => {
    const src = await workflow.glob("src/**", "package-lock.json", "tsconfig.json");
    const install = workflow.task({ name: "install", cmd: ["npm", "ci"] });
    const build = workflow.task({
      name: "build",
      cmd: ["tsc", "-p", "tsconfig.build.json"],
      deps: { install },
      inputs: src,
      cacheable: false,
    });
    const typecheck = workflow.task({
      name: "typecheck",
      cmd: ["tsc", "--noEmit"],
      deps: { install },
      inputs: src,
    });
    const lint = workflow.task({
      name: "lint",
      cmd: ["eslint", "src"],
      deps: { install },
      inputs: src,
    });
    const unit = workflow.task({
      name: "test:unit",
      cmd: ["vitest", "run", "unit"],
      deps: { build },
      inputs: src,
      concurrencyGroup: "test",
    });
    const e2e = workflow.task({
      name: "test:e2e",
      cmd: ["vitest", "run", "e2e"],
      deps: { build },
      inputs: src,
      concurrencyGroup: "test",
    });
    workflow.requireAll({ deps: { typecheck, lint, unit, e2e } });
  },
});
