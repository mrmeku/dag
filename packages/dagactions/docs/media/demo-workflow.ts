/** The workflow demo.tape records. The tools are fake-tool.sh, on PATH under their own names. */
import { defineWorkflow } from "@mrmeku/dagactions";

export default defineWorkflow({
  limits: { concurrencyLimits: { test: 1 } },
  build: (w) => {
    const install = w.run({ name: "install", cmd: ["npm", "ci"] });
    const build = w.run({
      name: "build",
      cmd: ["tsc", "-p", "tsconfig.build.json"],
      deps: { install },
    });
    const checks = w.runAll({
      typecheck: { cmd: ["tsc", "--noEmit"], deps: { install } },
      lint: { cmd: ["eslint", "src"], deps: { install } },
      "test:unit": { cmd: ["vitest", "run", "unit"], deps: { build }, group: "test" },
      "test:e2e": { cmd: ["vitest", "run", "e2e"], deps: { build }, group: "test" },
    });
    w.gate({ deps: checks });
  },
});
