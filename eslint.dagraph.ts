import type { Linter } from "eslint";
import boundaries from "eslint-plugin-boundaries";
import { join } from "node:path";

/**
 * dagraph's components, each a directory of `src`, and the components each may import: its import
 * edges, which run one way, so no two components import each other.
 */
const IMPORT_EDGES: Record<string, string[]> = {
  json: [],
  orchestration: ["json"],
  schedulers: ["orchestration"],
  mermaid: ["orchestration"],
  graph: ["orchestration", "json"],
  cache: ["graph"],
  "lookup-or-run": ["orchestration", "graph", "cache", "json"],
  filesystem: ["cache"],
};

const COMPONENTS = Object.keys(IMPORT_EDGES);

/** What a component's tests may import besides its import edges: what fills its ports. */
const PORT_FILLERS: Record<string, string[]> = {
  orchestration: ["schedulers"],
  graph: ["filesystem"],
  cache: ["filesystem"],
  "lookup-or-run": ["filesystem"],
};

/**
 * What runs in Temporal's workflow sandbox: these components, and the `./orchestration` entry,
 * import nothing but these components.
 */
const SANDBOX = ["orchestration", "schedulers", "json"];
const SANDBOX_MESSAGE =
  "What runs in the workflow sandbox imports nothing but orchestration/, schedulers/ and json/";

/** The components that read no global clock, timer or randomness: they take them as ports. */
const NO_GLOBALS = ["orchestration", "schedulers", "graph", "mermaid", "json", "lookup-or-run"];

/** The components whose tests touch no filesystem. */
const NO_FS_IN_TESTS = ["orchestration", "schedulers", "graph", "mermaid", "json"];

const FS_MODULES = ["fs", "fs/promises", "node:fs", "node:fs/promises"];

/** The published subpaths `./fs` and `./fs/node`, which a test may import. */
const DISK_ADAPTERS = ["bun.ts", "node.ts"];

const GLOBALS_MESSAGE =
  "Take the time, a timer or randomness as a port: a Clock, an StartTimer or a value passed in";
const READS = "Date|setTimeout|clearTimeout|crypto|globalThis";
/** Where an identifier names no value: a type, a property's name, a key. */
const NOT_READ = [
  "TSTypeReference > Identifier",
  "TSQualifiedName > Identifier",
  "TSTypeQuery > Identifier",
  "TSInterfaceHeritage > Identifier",
  "MemberExpression[computed=false] > Identifier.property",
  "Property[computed=false] > Identifier.key",
  "PropertyDefinition[computed=false] > Identifier.key",
  "MethodDefinition[computed=false] > Identifier.key",
  "TSPropertySignature[computed=false] > Identifier.key",
  "TSMethodSignature[computed=false] > Identifier.key",
].join(", ");

/**
 * The lint that pins dagraph's components: the import edges, what each test may import, that a
 * component is reached only through its `index.ts`, the module bans, the sandbox's reach and the
 * global bans. `packageDir` is dagraph's directory as the calling config's `files` name it.
 */
export function dagraphConfigs(packageDir: string): Linter.Config[] {
  const src = `${packageDir}/src`;
  const test = { file: { categories: "test" } };
  const notTest = { file: { categories: "source" } };
  const sandboxEntry = { file: { categories: "sandbox-entry" } };
  const index = (types: readonly string[]) => ({
    to: { element: { types: { anyOf: [...types] }, fileInternalPath: "index.ts" } },
  });
  const diskAdapters = {
    to: { element: { type: "filesystem", fileInternalPath: DISK_ADAPTERS } },
  };
  const fromComponent = (types: readonly string[], file = {}) => ({
    from: { element: { types: { anyOf: [...types] } }, ...file },
  });
  return [
    {
      files: [`${src}/**/*.ts`],
      plugins: { boundaries },
      settings: {
        "boundaries/root-path": join(import.meta.dirname, "packages/dagraph"),
        "boundaries/elements": [
          ...COMPONENTS.map((type) => ({ type, pattern: `src/${type}`, partialMatch: false })),
          { type: "root", pattern: "src", partialMatch: false },
        ],
        "boundaries/files": [
          { category: "test", pattern: "**/*.test.ts", stopMatching: true },
          { category: "sandbox-entry", pattern: "src/orchestration.ts" },
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
                { ...fromComponent([type]), allow: index(edges) },
                {
                  ...fromComponent([type], test),
                  allow: [index([...edges, ...(PORT_FILLERS[type] ?? [])]), diskAdapters],
                },
              ]),
              { ...fromComponent(["root"]), allow: index(COMPONENTS) },
              { ...fromComponent(["root"], test), allow: diskAdapters },
              {
                ...fromComponent(
                  [...COMPONENTS.filter((type) => type !== "filesystem"), "root"],
                  notTest,
                ),
                disallow: { to: { module: { origin: "core" } }, dependency: { kind: "value" } },
                message:
                  "Only filesystem/ imports an I/O module by value: do I/O through the cache's FileSystem port",
              },
              {
                ...fromComponent(NO_FS_IN_TESTS, test),
                disallow: { to: { module: { source: FS_MODULES } } },
                message: "This component's tests touch no filesystem: use the memory adapter",
              },
              {
                ...fromComponent(SANDBOX, notTest),
                disallow: { to: { module: { origin: ["external", "core"] } } },
                message: SANDBOX_MESSAGE,
              },
              {
                from: {
                  element: { type: "filesystem", fileInternalPath: ["index.ts", "memory.ts"] },
                },
                disallow: [
                  { to: { module: { origin: "core" } } },
                  { to: { element: { type: "filesystem", fileInternalPath: DISK_ADAPTERS } } },
                ],
                message:
                  "The package index loads filesystem/'s index and memory adapter: they import no I/O module and no disk adapter",
              },
              {
                ...fromComponent(["root"], sandboxEntry),
                disallow: [
                  { to: { module: { origin: ["external", "core"] } } },
                  { to: { element: { types: { noneOf: SANDBOX } } } },
                  { dependency: { relationship: { to: "internal" } } },
                ],
                message: SANDBOX_MESSAGE,
              },
            ],
          },
        ],
      },
    },
    {
      files: NO_GLOBALS.map((type) => `${src}/${type}/**/*.ts`).concat(
        `${packageDir}/lint/global-bans.ts`,
      ),
      ignores: ["**/*.test.ts"],
      rules: {
        "no-restricted-syntax": [
          "error",
          {
            selector: `Identifier[name=/^(?:${READS})$/]:not(${NOT_READ})`,
            message: GLOBALS_MESSAGE,
          },
          {
            selector: "MemberExpression[object.name='Math'][property.name='random']",
            message: GLOBALS_MESSAGE,
          },
        ],
      },
    },
    {
      // The fixture's directives are used only while each ban refuses its line.
      files: [`${packageDir}/lint/global-bans.ts`],
      linterOptions: { reportUnusedDisableDirectives: "error" },
    },
  ];
}
