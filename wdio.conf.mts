import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { browser } from "@wdio/globals";
import type {} from "wdio-obsidian-service";
import manifest from "./manifest.json" with { type: "json" };

export function createObsidianConfig({
  specs = ["./tests/e2e/**/*.e2e.ts"],
  vault = "tests/e2e/vault",
  defaultVersion = manifest.minAppVersion,
  chromeArgs = ["--window-size=1440,1000"],
  timeout = 60_000,
}: {
  specs?: string[];
  vault?: string;
  defaultVersion?: string;
  chromeArgs?: string[];
  timeout?: number;
} = {}): WebdriverIO.Config {
  const pluginPath = process.env.LANGDOCK_E2E_PLUGIN;
  if (!pluginPath) throw new Error("Use npm run test:e2e or npm run screenshots to start the isolated Langdock mock.");

  return {
    runner: "local",
    autoXvfb: false,
    framework: "mocha",
    specs,
    maxInstances: 1,
    capabilities: [{
      browserName: "obsidian",
      "wdio:obsidianOptions": {
        appVersion: process.env.OBSIDIAN_VERSION ?? defaultVersion,
        installerVersion: "earliest",
        plugins: [{ path: pluginPath, enabled: false }],
        vault,
        copy: true,
      },
      "goog:chromeOptions": {
        // Simulated keys stay in the test profile without opening the host keychain.
        args: process.platform === "linux" ? [...chromeArgs, "--password-store=basic"] : chromeArgs,
      },
    }],
    services: ["obsidian"],
    reporters: ["spec"],
    cacheDir: resolve(".obsidian-cache"),
    outputDir: resolve("e2e-results"),
    logLevel: "warn",
    injectGlobals: false,
    waitforTimeout: 10_000,
    connectionRetryCount: 0,
    mochaOpts: { ui: "bdd", timeout },
    async afterTest(test, _context, { passed }) {
      if (passed) return;
      await mkdir("e2e-results", { recursive: true });
      await browser.saveScreenshot(resolve("e2e-results", `${test.title.replace(/[^a-z0-9]+/gi, "-")}.png`));
    },
  };
}

export const config = createObsidianConfig();
