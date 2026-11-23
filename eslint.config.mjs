import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const typescriptFiles = ["src/**/*.ts", "tests/e2e/**/*.ts", "wdio*.conf.mts"];

export default tseslint.config(
  { ignores: ["main.js", ".obsidian-cache/**", "e2e-results/**"] },
  eslint.configs.recommended,
  { files: ["**/*.mjs"], languageOptions: { globals: globals.node } },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: typescriptFiles,
  })),
  {
    files: typescriptFiles,
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.mocha },
      parserOptions: { projectService: true },
    },
  },
);
