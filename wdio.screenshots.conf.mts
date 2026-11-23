import { createObsidianConfig } from "./wdio.conf.mts";

export const config = createObsidianConfig({
  specs: ["./tests/e2e/documentation.capture.ts"],
  vault: "tests/e2e/documentation-vault",
  defaultVersion: "1.15.1",
  chromeArgs: ["--window-size=1280,900", "--force-device-scale-factor=1"],
  timeout: 120_000,
});
