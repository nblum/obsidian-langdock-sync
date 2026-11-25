import { readFileSync } from "node:fs";

const projectLicense = readFileSync(new URL("../LICENSE", import.meta.url), "utf8").trim();
const yamlLicense = readFileSync(new URL("../node_modules/yaml/LICENSE", import.meta.url), "utf8").trim();

export const bundleOptions = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["obsidian"],
  loader: { ".webp": "dataurl" },
  define: { LANGDOCK_TEST_API_URL: "undefined" },
  banner: { js: `/*\nLangdock Sync\n${projectLicense}\n\nyaml\n${yamlLicense}\n*/` },
};
