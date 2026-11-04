import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import { dagraphConfigs } from "./eslint.dagraph.ts";

const FS_MODULES = ["node:fs", "node:fs/promises", "fs", "fs/promises"];

/**
 * dagworkflows' index loads no `@actions/*` package: the toolkit is an optional peer, loaded only
 * where GitHub is. Only the GitHub adapter's files import it by value: the action's options, the
 * `./github` subpath and the globber that `workflow.glob` loads lazily, which the rest may load
 * only with `import()`. Type imports and `import()` stay allowed.
 */
const DAGWORKFLOWS_GITHUB_FILES = ["src/action/env.ts", "src/ports/github.ts", "src/ports/glob.ts"];
const NO_GITHUB_IN_INDEX = "The index must load no GitHub package";
const dagworkflowsImports = {
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

export default defineConfig(
  {
    ignores: [
      "node_modules/",
      "packages/*/node_modules/",
      "packages/dagworkflows/action/dist/",
      ".dag/",
    ],
  },
  ...tseslint.configs.strictTypeChecked,
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
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='Date'][property.name='now'], NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            "Read the time from a clock: a clock port, ExecutionContext.clock or a value passed in",
        },
      ],
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["describe", "suite", "test", "it"] },
          ],
        },
      ],
      "@typescript-eslint/prefer-promise-reject-errors": [
        "error",
        { allowThrowingAny: true, allowThrowingUnknown: true },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowAny: false,
          allowBoolean: true,
          allowNever: false,
          allowNullish: true,
          allowNumber: true,
          allowRegExp: false,
        },
      ],
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-generated-empty-object-type": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-meaningless-void-operator": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unified-signatures": "off",
    },
  },
  {
    files: ["packages/*/src/**/*.ts"],
    ignores: [
      "packages/*/src/ports/**",
      "packages/dagraph/src/filesystem/{bun,node}.ts",
      "**/*.test.ts",
    ],
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
    files: ["packages/dagworkflows/src/**/*.ts"],
    ignores: DAGWORKFLOWS_GITHUB_FILES.map((file) => `packages/dagworkflows/${file}`),
    rules: { "@typescript-eslint/no-restricted-imports": ["error", dagworkflowsImports] },
  },
  ...dagraphConfigs("packages/dagraph"),
  {
    files: ["**/*.test.ts"],
    rules: { "@typescript-eslint/restrict-template-expressions": "off" },
  },
);
