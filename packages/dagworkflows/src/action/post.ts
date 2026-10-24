/**
 * dagworkflows as a JavaScript action, `post` entry: GitHub runs it at the end of the job whatever
 * became of `main`, in its own process. It runs the post steps the main run's history shows as
 * still owed: those a cancel or a kill kept from finishing, and those that failed every try.
 */
import { runPost } from "../runner.ts";
import { actionOptions } from "./env.ts";

export * from "../index.ts";

export async function main(): Promise<void> {
  process.exitCode = (await runPost(await actionOptions(import.meta.url))).exitCode;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
