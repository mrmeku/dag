/**
 * dagactions as a JavaScript action, `post` entry: GitHub runs it at the end of the job whatever
 * became of `main`, in its own process. It runs the post steps the main run's journal shows as
 * not reached: none after an ordinary run, the owed ones after a cancel or a kill.
 */
import { runPost } from "../runner.ts";
import { actionOptions } from "./env.ts";

export * from "../index.ts";

export async function main(): Promise<void> {
  const { failed } = await runPost(await actionOptions(import.meta.url));
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
