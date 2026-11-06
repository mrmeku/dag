import type { Linter } from "eslint";
import boundaries from "eslint-plugin-boundaries";
import { join } from "node:path";

/**
 * dagworkflows' components and group members, each a directory of `src`, and the indexes each may
 * import: the layout's dependency table. A member is listed before its group, so a member's file
 * is the member's.
 */
const IMPORT_EDGES: Record<string, string[]> = {
  config: [],
  "github-workflow-commands": [],
  "github-step-summary": ["config"],
  tasks: ["config", "github-workflow-commands"],
  kernel: ["tasks", "github-workflow-commands"],
  "run-store": ["kernel", "github-workflow-commands"],
  "summary-renderers": ["github-step-summary", "run-store", "kernel", "config"],
  host: [],
  reporter: ["host", "run-store", "kernel", "github-step-summary", "summary-renderers"],
  "actions-cache": ["tasks", "config"],
  "upload-artifact": ["tasks", "config"],
  selection: ["tasks", "actions-cache"],
  workflow: ["tasks", "actions-cache", "upload-artifact", "host", "lock", "config"],
  lock: ["config"],
  history: ["lock"],
  run: ["workflow", "selection", "history", "run-store", "kernel", "host", "reporter", "config"],
  wiring: [
    "run-store",
    "host",
    "actions-cache",
    "upload-artifact",
    "tasks",
    "lock",
    "workflow",
    "config",
  ],
  "test-ports": ["memory", "recording", "host", "actions-cache", "upload-artifact", "workflow"],
  "nodejs/exec": ["tasks", "config"],
  "nodejs/clock": ["tasks"],
  "nodejs/file-system": ["workflow", "wiring"],
  "nodejs/lockfile": ["lock"],
  "nodejs/file-matcher": ["upload-artifact", "github-workflow-commands"],
  nodejs: [
    "wiring",
    "nodejs/exec",
    "nodejs/clock",
    "nodejs/file-system",
    "nodejs/lockfile",
    "nodejs/file-matcher",
  ],
  "memory/exec": ["tasks"],
  "memory/clock": ["tasks"],
  "memory/file-system": ["workflow", "wiring"],
  "memory/lockfile": ["lock"],
  "memory/file-matcher": ["upload-artifact"],
  memory: [
    "wiring",
    "memory/exec",
    "memory/clock",
    "memory/file-system",
    "memory/lockfile",
    "memory/file-matcher",
  ],
  "local/host": ["host", "tasks"],
  "local/cache-store": ["actions-cache", "lock", "config"],
  "local/terminal": [
    "run-store",
    "kernel",
    "host",
    "reporter",
    "github-workflow-commands",
    "local/words",
    "config",
  ],
  "local/log-files": ["run-store", "host", "wiring", "kernel"],
  "local/failures-report": ["run-store", "host", "wiring", "kernel", "local/words", "config"],
  "local/words": ["kernel", "config"],
  local: [
    "wiring",
    "local/host",
    "local/cache-store",
    "local/terminal",
    "local/log-files",
    "local/failures-report",
    "upload-artifact",
    "run-store",
    "config",
  ],
  "github-actions/host": ["host", "github-workflow-commands", "config"],
  "github-actions/cache-store": ["actions-cache"],
  "github-actions/artifact-store": ["upload-artifact"],
  "github-actions": [
    "wiring",
    "github-actions/host",
    "github-actions/cache-store",
    "github-actions/artifact-store",
    "actions-cache",
    "upload-artifact",
    "host",
    "github-workflow-commands",
  ],
  "recording/host": ["host"],
  "recording/cache-store": ["actions-cache"],
  "recording/artifact-store": ["upload-artifact"],
  recording: ["wiring", "recording/host", "recording/cache-store", "recording/artifact-store"],
  cli: ["wiring", "run", "workflow", "nodejs", "local", "github-actions", "config"],
  action: ["wiring", "run", "workflow", "nodejs", "github-actions", "config"],
};

const COMPONENTS = Object.keys(IMPORT_EDGES);

/** Edges allowed for `import type` alone. */
const TYPE_EDGES: Record<string, string[]> = {
  workflow: ["github-step-summary", "run-store"],
  "local/terminal": ["wiring"],
};

/** What a component's tests may import beyond its edges: the doubles its tests take. */
const TEST_FILLERS: Record<string, string[]> = {
  tasks: ["memory"],
  "actions-cache": ["memory", "recording"],
  "upload-artifact": ["memory", "recording"],
  workflow: ["memory", "recording"],
  reporter: ["recording"],
  history: ["memory"],
  run: ["memory", "recording"],
  wiring: ["memory"],
  local: ["memory"],
  "local/host": ["nodejs"],
  "local/cache-store": ["memory"],
  "local/terminal": ["recording"],
  "local/log-files": ["memory", "recording"],
  "local/failures-report": ["memory", "recording"],
  "github-actions": ["memory"],
};

/** The hexagons, which may reach the package index in their tests as a program does. */
const HEXAGONS = ["cli", "action"];

/** The only places an I/O module is imported by value. */
const IO_MODULES = [
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
  "child_process",
  "node:child_process",
  "proper-lockfile",
];
const IO_ADAPTERS = ["nodejs/exec", "nodejs/file-system", "nodejs/lockfile", "local/cache-store"];

const NO_TOOLKIT_IN_INDEX = "The index must load no GitHub package";

/**
 * The lint that pins dagworkflows' components: the import edges, what each test may import, that
 * a component is reached only through its `index.ts` and a group's member only through its group,
 * the package entries, and where an I/O or toolkit module may be imported by value.
 * `packageDir` is dagworkflows' directory as the calling config's `files` name it.
 */
export function dagworkflowsConfigs(packageDir: string): Linter.Config[] {
  const src = `${packageDir}/src`;
  const test = { file: { categories: "test" } };
  const notTest = { file: { categories: "source" } };
  const index = (types: readonly string[]) => ({
    to: { element: { types: { anyOf: [...types] }, fileInternalPath: "index.ts" } },
  });
  const from = (types: readonly string[], file = {}) => ({
    from: { element: { types: { anyOf: [...types] } }, ...file },
  });
  const fromFiles = (type: string, files: string[], file = {}) => ({
    from: { element: { type, fileInternalPath: files }, ...file },
  });
  const toolkit = { to: { module: { source: "@actions/*" } }, dependency: { kind: "value" } };
  return [
    {
      files: [`${src}/**/*.ts`],
      plugins: { boundaries },
      settings: {
        "boundaries/root-path": join(import.meta.dirname, "packages/dagworkflows"),
        "boundaries/dependency-nodes": ["import", "dynamic-import", "export"],
        "boundaries/elements": [
          ...COMPONENTS.map((type) => ({ type, pattern: `src/${type}`, partialMatch: false })),
          { type: "root", pattern: "src", partialMatch: false },
        ],
        "boundaries/files": [
          { category: "test", pattern: ["**/*.test.ts", "**/*.e2e.ts"], stopMatching: true },
          { category: "source", pattern: "**/*.ts" },
        ],
      },
      rules: {
        "boundaries/no-unknown-files": "error",
        "boundaries/dependencies": [
          "error",
          {
            default: "disallow",
            checkAllOrigins: true,
            checkUnknownLocals: true,
            checkInternals: true,
            policies: [
              { allow: { to: { module: { origin: ["external", "core"] } } } },
              { allow: { dependency: { relationship: { to: "internal" } } } },
              ...Object.entries(IMPORT_EDGES).flatMap(([type, edges]) => [
                { ...from([type]), allow: index(edges) },
                {
                  ...from([type]),
                  allow: { ...index(TYPE_EDGES[type] ?? []), dependency: { kind: "type" } },
                },
                { ...from([type], test), allow: index(TEST_FILLERS[type] ?? []) },
              ]),
              { ...from(HEXAGONS, test), allow: { to: { element: { type: "root" } } } },
              {
                ...fromFiles("root", ["index.ts"]),
                allow: [
                  index(COMPONENTS.filter((type) => !["local", ...HEXAGONS].includes(type))),
                  { to: { element: { type: "local", fileInternalPath: "local-host.ts" } } },
                ],
              },
              {
                ...fromFiles("root", ["github.ts"]),
                allow: {
                  to: { element: { type: "github-actions", fileInternalPath: "github.ts" } },
                },
              },
              { ...fromFiles("root", ["local.ts"]), allow: index(["local"]) },
              {
                ...fromFiles("action", ["main.ts", "post.ts"]),
                allow: { to: { element: { type: "root", fileInternalPath: "index.ts" } } },
              },
              {
                ...fromFiles("local", ["local-host.ts"]),
                allow: index(["local/host"]),
              },
              {
                ...fromFiles("github-actions", ["github.ts"]),
                allow: index(["github-actions/host", "github-workflow-commands"]),
              },
              {
                ...from(
                  [...COMPONENTS.filter((type) => !IO_ADAPTERS.includes(type)), "root"],
                  notTest,
                ),
                disallow: { to: { module: { source: IO_MODULES } }, dependency: { kind: "value" } },
                message: "Do I/O through a port; only an adapter imports an I/O module",
              },
              {
                ...from(
                  COMPONENTS.filter(
                    (type) =>
                      !["action", "cli", "nodejs/file-matcher", "github-actions"].includes(type),
                  ).concat("root"),
                  notTest,
                ),
                disallow: toolkit,
                message: `${NO_TOOLKIT_IN_INDEX}: load it through github-actions/' ToolkitLoader`,
              },
              {
                ...from(["github-actions"], notTest),
                disallow: toolkit,
                message: `${NO_TOOLKIT_IN_INDEX}: only github-actions/github.ts imports it statically`,
              },
              { ...fromFiles("github-actions", ["github.ts"], notTest), allow: toolkit },
              {
                ...from(["cli", "nodejs/file-matcher"], notTest),
                disallow: { ...toolkit, dependency: { kind: "value", nodeKind: "import" } },
                message: `${NO_TOOLKIT_IN_INDEX}: load it with import()`,
              },
            ],
          },
        ],
      },
    },
  ];
}
