import type LangdockSyncPlugin from "../../src/main.ts";

declare module "wdio-obsidian-service" {
  interface InstalledPlugins {
    langdockSync: LangdockSyncPlugin;
  }
}
