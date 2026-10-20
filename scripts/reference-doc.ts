/**
 * Fills the generated sections of packages/dagactions/docs/reference.md from their sources: the
 * CLI's commander program, the action's action.yml and the paths in config.ts. The prose around
 * them is the file's own. `bun run docs` writes it; reference-doc.test.ts fails while it is stale.
 */
import type { Option } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { parse } from "yaml";
import { program } from "../packages/dagactions/src/cli.ts";
import {
  DEFAULT_CAS_DIR,
  DEFAULT_FAILURES_REPORT_PATH,
  DEFAULT_HISTORY_DIR,
  DEFAULT_LOG_DIR,
  DEFAULT_SUMMARY_PATH,
  LAST_RUN_FILE,
} from "../packages/dagactions/src/config.ts";
import { logPath } from "../packages/dagactions/src/step-records.ts";

export const REFERENCE_PATH = fileURLToPath(
  new URL("../packages/dagactions/docs/reference.md", import.meta.url),
);
const ACTION_YML_PATH = fileURLToPath(
  new URL("../packages/dagactions/action/action.yml", import.meta.url),
);

interface ActionInput {
  description: string;
  required?: boolean;
  default?: string;
}

const code = (text: string) => `\`${text}\``;
const sentence = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}.`;
const table = (header: string[], rows: string[][]) =>
  [header, header.map(() => "-"), ...rows].map((cells) => `| ${cells.join(" | ")} |`);

function cliLines(): string[] {
  const usage = program.commands.map(
    (command) =>
      `npx dagactions ${command.name()} ${command.registeredArguments.map((a) => `<${a.name()}>`).join(" ")} [options]`,
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
  const { inputs } = parse(readFileSync(ACTION_YML_PATH, "utf8")) as {
    inputs: Record<string, ActionInput>;
  };
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
  return table(
    ["Path", "Content"],
    [
      [
        `${DEFAULT_CAS_DIR}/`,
        "The outputs of each step, by cache key. Cache this directory between runs.",
      ],
      [
        logPath(DEFAULT_CAS_DIR, "<key>"),
        "The log of each step, next to the CAS and not in it. Never cache it.",
      ],
      [
        `${DEFAULT_CAS_DIR}/${LAST_RUN_FILE}`,
        "The time of each step in the last run. The footer and the step summary compare with it.",
      ],
      [
        `${DEFAULT_HISTORY_DIR}/`,
        "The history of each run: each step that finished, with the run's lock. `dagactions post`, the action's `post` entry and the next run read them.",
      ],
      [`${DEFAULT_LOG_DIR}/`, "Local runs only: the log of each step, while it runs."],
      [DEFAULT_FAILURES_REPORT_PATH, "Local runs only: the report of the failures."],
      [DEFAULT_SUMMARY_PATH, "Local runs only: the step summary that GitHub would show."],
    ].map(([path, content]) => [code(path!), content!]),
  );
}

const SECTIONS: Record<string, () => string[]> = {
  cli: cliLines,
  action: actionLines,
  files: fileLines,
};

/** The document with each `<!-- generated:name -->` section filled again from its source. */
export async function referenceDoc(current: string): Promise<string> {
  const filled = new Set<string>();
  const doc = current.replace(
    /(<!-- generated:(\w+) -->)[\s\S]*?(<!-- \/generated:\2 -->)/g,
    (_, open: string, name: string, close: string) => {
      const lines = SECTIONS[name];
      if (!lines) throw new Error(`${REFERENCE_PATH}: no generator for section "${name}"`);
      filled.add(name);
      return `${open}\n\n${lines().join("\n")}\n\n${close}`;
    },
  );
  const missing = Object.keys(SECTIONS).filter((name) => !filled.has(name));
  if (missing.length > 0)
    throw new Error(`${REFERENCE_PATH}: no section for ${missing.join(", ")}`);
  const options = await resolveConfig(REFERENCE_PATH);
  return format(doc, { ...options, filepath: REFERENCE_PATH });
}

if (import.meta.main) {
  writeFileSync(REFERENCE_PATH, await referenceDoc(readFileSync(REFERENCE_PATH, "utf8")));
}
