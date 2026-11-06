/**
 * dagworkflows as a JavaScript action, `main` entry. The runner hands an action's main script the
 * cache service token that `run:` steps never see, so `@actions/cache` works here without
 * workarounds; and the bundled `dist` runs before `install`, so a package cache is a node like
 * any other. When the job is cancelled the runner signals this process, the run stops, and the
 * `post` entry runs the post steps it did not reach.
 */
import { nodejsRuntime } from "../nodejs/index.ts";
import { runWorkflow } from "../run/index.ts";
import { actionOptions } from "./env.ts";

export * from "../index.ts";

async function main(): Promise<void> {
  const outcome = await runWorkflow({
    ...(await actionOptions(import.meta.url, "run")),
    signal: nodejsRuntime.abortOnSignals(),
  });
  process.exitCode = outcome.exitCode;
}

// Not awaited: the workflow file imports this very module through the hook, and an import of
// a module that is still evaluating would wait for it, so main must run after evaluation ends.
main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
