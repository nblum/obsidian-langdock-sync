import { build, context } from "esbuild";
import { bundleOptions } from "./scripts/bundle-options.mjs";

const watch = process.argv.includes("--watch");
const options = {
  ...bundleOptions,
  outfile: "main.js",
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

if (watch) {
  await (await context(options)).watch();
} else {
  await build(options);
}
