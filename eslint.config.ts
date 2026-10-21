import tseslint from "typescript-eslint";

const FS_MODULES = ["node:fs", "node:fs/promises", "fs", "fs/promises"];

/**
 * dagactions' index loads no `@actions/*` package: the toolkit is an optional peer, loaded only
 * where GitHub is. Only the GitHub adapter's files import it by value: the action's options, the
 * `./github` subpath and the globber that `w.glob` loads lazily, which the rest may load only
 * with `import()`. Type imports and `import()` stay allowed.
 */
const DAGACTIONS_GITHUB_FILES = ["src/action/env.ts", "src/ports/github.ts", "src/ports/glob.ts"];
const NO_GITHUB_IN_INDEX = "The index must load no GitHub package";
const dagactionsImports = {
  patterns: [
    {
      group: ["@actions/*"],
      allowTypeImports: true,
      message: `${NO_GITHUB_IN_INDEX}: import it lazily, or from the ./github adapter.`,
    },
    {
      regex: "^\\.{1,2}/(?:.*/)?(?:github|glob)\\.ts$",
      allowTypeImports: true,
      message: `${NO_GITHUB_IN_INDEX}: load the toolkit's adapters lazily, with import().`,
    },
  ],
};

/**
 * dagraph's index reaches no I/O module, so Temporal can bundle it into its workflow sandbox.
 * Only the file system adapters, published as the `/fs` and `/fs/node` subpaths, import one, and
 * no other file of the package imports them.
 */
const DAGRAPH_ADAPTERS = ["src/ports/fs.ts", "src/ports/node-fs.ts"];
const NO_IO_IN_INDEX =
  "dagraph's index must reach no I/O module: Temporal bundles it into its workflow sandbox";
const dagraphImports = {
  patterns: [
    {
      regex: "^(?:node:|bun$|fs$|fs/|child_process$|os$|path$)",
      message: `${NO_IO_IN_INDEX}. Do I/O in a file system adapter, published as a subpath.`,
    },
    {
      regex: "^\\.{1,2}/(?:.*/)?(?:fs|node-fs)\\.ts$",
      message: `${NO_IO_IN_INDEX}. Import its file system adapters by their subpaths, outside the package.`,
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "packages/*/node_modules/",
      "packages/dagactions/action/dist/",
      ".dagactions/",
    ],
  },
  ...tseslint.configs.recommended,
  // Two tsconfig roots exist in the monorepo (the root's and dag/'s); name this one.
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
    },
  },
  {
    files: ["packages/*/src/**/*.ts"],
    ignores: ["packages/*/src/ports/**", "**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: FS_MODULES.map((name) => ({
            name,
            message: "Use the FileSystem port instead of direct fs imports.",
          })),
        },
      ],
    },
  },
  {
    files: ["packages/dagactions/src/**/*.ts"],
    ignores: DAGACTIONS_GITHUB_FILES.map((file) => `packages/dagactions/${file}`),
    rules: { "@typescript-eslint/no-restricted-imports": ["error", dagactionsImports] },
  },
  {
    files: ["packages/dagraph/src/**/*.ts"],
    ignores: [...DAGRAPH_ADAPTERS.map((file) => `packages/dagraph/${file}`), "**/*.test.ts"],
    rules: { "@typescript-eslint/no-restricted-imports": ["error", dagraphImports] },
  },
);
