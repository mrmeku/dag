import { relative } from "node:path";
import { isDebugCommand } from "../../github-workflow-commands/index.ts";
import type { FileMatcher } from "../../upload-artifact/index.ts";

/**
 * Drops each string chunk `isDebugCommand` names from stdout for the rest of the process: the
 * globber writes one for every file it visits, past any host, which GitHub hides and a terminal
 * does not.
 */
function dropDebugCommands() {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ) =>
    typeof chunk === "string" && isDebugCommand(chunk)
      ? true
      : typeof encoding === "function"
        ? write(chunk, encoding)
        : write(chunk, encoding, cb);
}

let loaded: Promise<typeof import("@actions/glob")> | undefined;

/** `@actions/glob`, loaded on first use: it brings half the toolkit, which importing the package must not. */
const toolkitGlob = () =>
  (loaded ??= import("@actions/glob").then((glob) => {
    if (!process.env["GITHUB_ACTIONS"]) dropDebugCommands();
    return glob;
  }));

/** `@actions/glob` over the real working tree. */
export const fileMatcher: FileMatcher = {
  match: async (patterns) => {
    const globber = await (
      await toolkitGlob()
    ).create(patterns.join("\n"), {
      matchDirectories: false,
    });
    const cwd = process.cwd();
    return [...new Set((await globber.glob()).map((path) => relative(cwd, path)))].sort();
  },
  hash: async (patterns) => (await toolkitGlob()).hashFiles(patterns.join("\n")),
};
