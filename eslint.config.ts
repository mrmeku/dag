import tseslint from "typescript-eslint";

const FS_MODULES = ["node:fs", "node:fs/promises", "fs", "fs/promises"];

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
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
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
);
