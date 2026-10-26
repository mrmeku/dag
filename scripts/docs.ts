/**
 * Regenerates what the packages' docs do not hold by hand: each package's API reference in
 * docs/api/, written by TypeDoc from the TSDoc of each entry of its exports map (typedoc.json), and
 * the `<!-- generated:name -->` sections of the dagworkflows README and the action's README, from
 * the CLI's commander program, the action's action.yml and the paths in config.ts. `bun run docs`
 * writes them. With --check it writes them into a copy instead and fails while the copy differs:
 * the release runs it so, as docs are written for a release.
 */
import type { Option } from "@commander-js/extra-typings";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { parse } from "yaml";
import { program } from "../packages/dagworkflows/src/cli.ts";
import {
  DEFAULT_CAS_DIR,
  DEFAULT_FAILURES_REPORT_PATH,
  DEFAULT_HISTORY_DIR,
  DEFAULT_LOG_DIR,
  DEFAULT_SUMMARY_PATH,
  LAST_RUN_FILE,
} from "../packages/dagworkflows/src/config.ts";
import { logPath } from "../packages/dagworkflows/src/step-records.ts";

const DAG_DIR = fileURLToPath(new URL("..", import.meta.url));
const PACKAGES = ["dagraph", "dagworkflows"];
const TYPEDOC = fileURLToPath(new URL("bin/typedoc", import.meta.resolve("typedoc/package.json")));
const ACTION_YML_PATH = join(DAG_DIR, "packages/dagworkflows/action/action.yml");
const docsDir = (root: string, pkg: string) => join(root, "packages", pkg, "docs");

interface ActionInput {
  description: string;
  required?: boolean;
  default?: string;
}

const isActionInput = (v: unknown): v is ActionInput =>
  typeof v === "object" &&
  v !== null &&
  "description" in v &&
  typeof v.description === "string" &&
  (!("required" in v) || typeof v.required === "boolean") &&
  (!("default" in v) || typeof v.default === "string");

const isActionInputs = (v: unknown): v is Record<string, ActionInput> =>
  typeof v === "object" && v !== null && Object.values(v).every(isActionInput);

const code = (text: string) => `\`${text}\``;
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
const table = (header: string[], rows: string[][]) =>
  [header, header.map(() => "-"), ...rows].map((cells) => `| ${cells.join(" | ")} |`);

function cliLines(): string[] {
  const usage = program.commands.map(
    (command) =>
      `npx --no dag ${command.name()} ${command.registeredArguments.map((a) => `<${a.name()}>`).join(" ")} [options]`,
  );
  const commandRows = program.commands.map((command) => [
    code(command.name()),
    sentence(command.description()),
  ]);
  const commandsOf = new Map<string, { option: Option; commands: string[] }>();
  for (const command of program.commands) {
    for (const option of command.options) {
      const entry = commandsOf.get(option.flags) ?? { option, commands: [] };
      entry.commands.push(code(command.name()));
      commandsOf.set(option.flags, entry);
    }
  }
  const optionRows = [...commandsOf.values()].map(({ option, commands }) => [
    code(option.flags),
    commands.join(", "),
    option.defaultValue === undefined ? "" : code(String(option.defaultValue)),
    [
      sentence(option.description),
      option.argChoices && `One of ${option.argChoices.map(code).join(", ")}.`,
      option.envVar && `Also set by ${code(option.envVar)}.`,
    ]
      .filter(Boolean)
      .join(" "),
  ]);
  return [
    "```",
    ...usage,
    "```",
    "",
    ...table(["Command", "What it does"], commandRows),
    "",
    ...table(["Option", "Commands", "Default", "Meaning"], optionRows),
  ];
}

function actionLines(): string[] {
  const action: unknown = parse(readFileSync(ACTION_YML_PATH, "utf8"));
  const inputs =
    typeof action === "object" && action !== null && "inputs" in action && action.inputs;
  if (!isActionInputs(inputs)) throw new Error(`${ACTION_YML_PATH}: inputs are not action inputs`);
  return table(
    ["Input", "Default", "Meaning"],
    Object.entries(inputs).map(([name, input]) => [
      code(name),
      input.default === undefined ? "" : code(input.default),
      `${sentence(input.description)}${input.required ? " Required." : ""}`,
    ]),
  );
}

function fileLines(): string[] {
  const files: [string, string][] = [
    [
      `${DEFAULT_CAS_DIR}/`,
      "The outputs of each task, by cache key. Cache this directory between runs.",
    ],
    [
      logPath(DEFAULT_CAS_DIR, "<key>"),
      "The log of each task, next to the CAS and not in it. Never cache it.",
    ],
    [
      `${DEFAULT_CAS_DIR}/${LAST_RUN_FILE}`,
      "The time of each task in the last run. The footer and the step summary compare with it.",
    ],
    [
      `${DEFAULT_HISTORY_DIR}/`,
      "The history of each run: each task that finished, with the run's lock. `dag post`, the action's `post` entry and the next run read them.",
    ],
    [`${DEFAULT_LOG_DIR}/`, "Local runs only: the log of each task, while it runs."],
    [DEFAULT_FAILURES_REPORT_PATH, "Local runs only: the report of the failures."],
    [DEFAULT_SUMMARY_PATH, "Local runs only: the step summary that GitHub would show."],
  ];
  return table(
    ["Path", "Content"],
    files.map(([path, content]) => [code(path), content]),
  );
}

const PAGES: Record<string, Record<string, () => string[]>> = {
  "packages/dagworkflows/README.md": { cli: cliLines, files: fileLines },
  "packages/dagworkflows/action/README.md": { action: actionLines },
};
/** Everything the generator writes, relative to the dag directory. */
const GENERATED = [...PACKAGES.map((pkg) => join("packages", pkg, "docs")), ...Object.keys(PAGES)];

/**
 * The page with each of its sections filled again, formatted as the page in the tree is, wherever
 * the copy is; one it lacks, or one it has no generator for, throws.
 */
async function filledPage(
  file: string,
  sections: Record<string, () => string[]>,
  current: string,
): Promise<string> {
  const path = join(DAG_DIR, file);
  const filled = new Set<string>();
  const page = current.replace(
    /(<!-- generated:(\w+) -->)[\s\S]*?(<!-- \/generated:\2 -->)/g,
    (_, open: string, name: string, close: string) => {
      const lines = sections[name];
      if (!lines) throw new Error(`${path}: no generator for section "${name}"`);
      filled.add(name);
      return `${open}\n\n${lines().join("\n")}\n\n${close}`;
    },
  );
  const missing = Object.keys(sections).filter((name) => !filled.has(name));
  if (missing.length > 0) throw new Error(`${path}: no section for ${missing.join(", ")}`);
  return format(page, { ...(await resolveConfig(path)), filepath: path });
}

/** TypeDoc infers a package's entry points from the package.json in its working directory. */
function writeApiReference(pkg: string, out: string): void {
  const args = [TYPEDOC, "--options", join(DAG_DIR, "typedoc.json"), "--out", out];
  const { error, status } = spawnSync(process.execPath, args, {
    cwd: join(DAG_DIR, "packages", pkg),
    stdio: "inherit",
  });
  if (error) throw error;
  if (status !== 0) throw new Error(`typedoc exited ${status} for ${pkg}`);
}

async function writeDocs(root: string): Promise<void> {
  for (const [file, sections] of Object.entries(PAGES)) {
    const path = join(root, file);
    writeFileSync(path, await filledPage(file, sections, readFileSync(path, "utf8")));
  }
  for (const pkg of PACKAGES) writeApiReference(pkg, join(docsDir(root, pkg), "api"));
}

if (process.argv.includes("--check")) {
  const copy = mkdtempSync(join(tmpdir(), "dag-docs-"));
  try {
    for (const path of GENERATED)
      cpSync(join(DAG_DIR, path), join(copy, path), { recursive: true });
    await writeDocs(copy);
    const stale = GENERATED.filter((path) => {
      const diff = spawnSync("diff", ["-rq", join(DAG_DIR, path), join(copy, path)], {
        stdio: "inherit",
      });
      if (diff.error) throw diff.error;
      return diff.status !== 0;
    });
    if (stale.length > 0) {
      console.error(`${stale.join(", ")}: stale, run \`bun run docs\``);
      process.exitCode = 1;
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
} else await writeDocs(DAG_DIR);
