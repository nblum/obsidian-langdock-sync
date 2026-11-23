import { Modal, PluginSettingTab, Setting } from "obsidian";
import type { App } from "obsidian";
import { isVisiblePath } from "./config.ts";
import { renderAbout } from "./help.ts";
import { formatIssue, isLanguagePreference, issueFromError, languageNames } from "./i18n.ts";
import type { Issue, LanguagePreference, TranslationKey, Translator } from "./i18n.ts";
import type { Folder } from "./langdock.ts";
import type LangdockSyncPlugin from "./main.ts";
import type { Plan } from "./sync.ts";

interface StatusMessage {
  text: string;
  tone: "info" | "success" | "error";
}

function renderMessage(container: HTMLElement, { text, tone }: StatusMessage): HTMLParagraphElement {
  return container.createEl("p", {
    cls: ["langdock-sync-message", `langdock-sync-message--${tone}`],
    text,
  });
}

function appendLinkedHelp(help: HTMLElement, text: string, label: string, href: string): void {
  const [before = "", after = ""] = text.split("{link}");
  help.append(before);
  help.createEl("a", {
    text: label,
    cls: "external-link",
    attr: { href, target: "_blank", rel: "noopener" },
  });
  help.append(after);
}

export class LangdockSettingTab extends PluginSettingTab {
  private targets: Folder[] = [];
  private statusEl?: HTMLElement;
  private connectionMessage: { key: TranslationKey; tone: StatusMessage["tone"]; variables?: Issue["variables"] } | null = null;
  private request = 0;
  private open = false;
  private changingKey = false;

  constructor(private readonly plugin: LangdockSyncPlugin) {
    super(plugin.app, plugin);
  }

  override display(): void {
    this.open = true;
    const { containerEl } = this;
    const { config: settings, translate: t } = this.plugin;
    const hasApiKey = !this.changingKey && this.plugin.hasApiKey();
    containerEl.empty();

    const { manifest } = this.plugin;
    const header = containerEl.createEl("header", { cls: "langdock-sync-settings-header" });
    header.createEl("h2", { text: manifest.name });
    renderAbout(header, t, manifest);

    new Setting(containerEl)
      .setName(t("language.label"))
      .setDesc(t("language.help"))
      .addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute("aria-label", t("language.label"));
        dropdown.addOption("auto", t("language.auto"))
          .addOptions(languageNames)
          .setValue(this.plugin.languagePreference)
          .setDisabled(this.changingKey)
          .onChange((value) => {
            if (isLanguagePreference(value)) void this.changeLanguage(value);
          });
      });

    new Setting(containerEl).setClass("langdock-sync-controls")
      .addButton((button) => button.setButtonText(t("commands.showIntroduction"))
        .onClick(() => { this.plugin.showIntroduction(); }))
      .addButton((button) => button.setButtonText(t("commands.showAbout"))
        .onClick(() => { this.plugin.showAbout(); }));

    new Setting(containerEl).setName(t("settings.connection")).setHeading();
    let keyInput: HTMLInputElement;
    new Setting(containerEl)
      .setName(t("settings.apiKey"))
      .setDesc(hasApiKey ? t("settings.keySet") : t("settings.keyStorage"))
      .addText((input) => {
        keyInput = input.inputEl;
        keyInput.type = "password";
        keyInput.autocomplete = "off";
        keyInput.setAttribute("aria-label", t("settings.apiKey"));
        input.setDisabled(this.changingKey);
      })
      .addButton((button) => button.setButtonText(t("settings.saveKey"))
        .setDisabled(this.changingKey)
        .onClick(() => { void this.saveApiKey(keyInput.value); }));

    appendLinkedHelp(
      containerEl.createEl("p", { cls: "langdock-sync-help" }),
      t("settings.workspaceKeyHelp", { scope: "KNOWLEDGE_FOLDER_API" }),
      t("settings.workspaceApiLink"),
      "https://app.langdock.com/settings/workspace/products/api",
    );

    new Setting(containerEl)
      .setName(t("settings.knowledgeBase"))
      .setDesc(t("settings.editorHelp"))
      .addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute("aria-label", t("settings.knowledgeBase"));
        dropdown.addOption("", t("settings.select"));
        if (settings.folderId && !this.targets.some(({ id }) => id === settings.folderId)) {
          dropdown.addOption(settings.folderId, t("settings.savedTarget", { id: settings.folderId }));
          dropdown.selectEl.options[dropdown.selectEl.options.length - 1]?.setAttribute("disabled", "");
        }
        for (const folder of this.targets) {
          dropdown.addOption(folder.id, folder.role === "EDITOR" ? folder.name : t("settings.readOnlyTarget", { name: folder.name }));
          if (folder.role !== "EDITOR") {
            dropdown.selectEl.options[dropdown.selectEl.options.length - 1]?.setAttribute("disabled", "");
          }
        }
        dropdown.setDisabled(this.changingKey).setValue(settings.folderId).onChange((folderId) => {
          if (folderId && !this.targets.some(({ id, role }) => id === folderId && role === "EDITOR")) return;
          this.request++;
          this.connectionMessage = null;
          void this.change({ folderId });
        });
      });

    new Setting(containerEl).setClass("langdock-sync-controls")
      .addButton((button) => button.setButtonText(t("settings.loadTargets"))
        .setDisabled(!hasApiKey)
        .onClick(() => { void this.refreshFolders(false); }))
      .addButton((button) => button.setButtonText(t("settings.testConnection"))
        .setDisabled(!hasApiKey)
        .onClick(() => { void this.refreshFolders(true); }));

    if (this.connectionMessage) {
      const { key, tone, variables } = this.connectionMessage;
      renderMessage(containerEl, { text: t(key, variables), tone }).setAttribute("role", "status");
    }

    this.renderScope();
    const canSync = hasApiKey && !!settings.folderId && settings.folders.length > 0;
    new Setting(containerEl)
      .setName(t("settings.automatic"))
      .setDesc(t("settings.automaticHelp"))
      .addToggle((toggle) => toggle.setDisabled(!canSync)
        .setValue(settings.automatic)
        .onChange((automatic) => { void this.change({ automatic }); }));

    new Setting(containerEl)
      .setName(t("settings.sync"))
      .addButton((button) => button.setButtonText(t("settings.preview")).setDisabled(!canSync)
        .onClick(() => { void this.plugin.showPreview(); }))
      .addButton((button) => button.setButtonText(t("commands.syncNow")).setCta().setDisabled(!canSync)
        .onClick(() => { void this.plugin.syncNow(); }));

    this.statusEl = containerEl.createDiv({ cls: "langdock-sync-status", attr: { role: "status" } });
    this.renderStatus();
  }

  private renderScope(): void {
    const { containerEl } = this;
    const { folders, propertyFilters } = this.plugin.config;
    const t = this.plugin.translate;
    const available = ["/", ...this.app.vault.getAllFolders(false).map(({ path }) => path)
      .filter(isVisiblePath).sort((left, right) => left.localeCompare(right))];
    const folderName = (path: string) => path === "/" ? t("settings.vaultRoot") : path;

    new Setting(containerEl).setName(t("settings.manageFolders")).setHeading();
    containerEl.createEl("p", {
      cls: "langdock-sync-help",
      text: t("settings.foldersHelp"),
    });
    new Setting(containerEl)
      .addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute("aria-label", t("settings.folderPicker"));
        dropdown.addOption("", t("settings.addFolder"));
        for (const path of available) {
          if (!folders.includes(path)) dropdown.addOption(path, folderName(path));
        }
        dropdown.setDisabled(this.changingKey).onChange((path) => {
          if (path) void this.change({ folders: [...folders, path] });
        });
      });
    for (const path of folders) {
      const row = new Setting(containerEl).setName(folderName(path));
      if (!available.includes(path)) row.setDesc(t("settings.folderMissing"));
      row.addExtraButton((button) => button.setIcon("x").setTooltip(t("settings.removeFolder", { name: folderName(path) }))
        .setDisabled(this.changingKey)
        .onClick(() => { void this.change({ folders: folders.filter((folder) => folder !== path) }); }));
    }

    new Setting(containerEl).setName(t("settings.manageProperties")).setHeading();
    const propertyHelp = containerEl.createEl("p", { cls: "langdock-sync-help" });
    propertyHelp.createEl("strong", { text: t("settings.propertiesLogic") });
    propertyHelp.createEl("br");
    for (const [index, part] of t("settings.propertiesExample").split("`").entries()) {
      if (index % 2 === 0) propertyHelp.append(part);
      else propertyHelp.createEl("code", { text: part });
    }
    propertyHelp.createEl("br");
    appendLinkedHelp(
      propertyHelp,
      t("settings.propertiesHelp"),
      "Classificator",
      "https://github.com/nblum/obsidian-classificator",
    );
    let propertyInput: HTMLInputElement;
    let valueInput: HTMLInputElement;
    new Setting(containerEl).setClass("langdock-sync-controls")
      .addText((input) => {
        propertyInput = input.inputEl;
        propertyInput.setAttribute("aria-label", t("settings.propertyLabel"));
        input.setPlaceholder(t("settings.propertyPlaceholder")).setDisabled(this.changingKey);
      })
      .addText((input) => {
        valueInput = input.inputEl;
        valueInput.setAttribute("aria-label", t("settings.valueLabel"));
        input.setPlaceholder(t("settings.valuePlaceholder")).setDisabled(this.changingKey);
      })
      .addButton((button) => button.setButtonText(t("settings.addFilter"))
        .setDisabled(this.changingKey)
        .onClick(() => {
          const property = propertyInput.value.trim();
          const value = valueInput.value.trim();
          if (!property || !value) {
            this.plugin.notify(t("errors.propertyRequired"));
            return;
          }
          if (propertyFilters.some((filter) => filter.property === property && filter.value === value)) return;
          void this.change({ propertyFilters: [...propertyFilters, { property, value }] });
        }));
    for (const filter of propertyFilters) {
      const label = `${filter.property} = ${filter.value}`;
      new Setting(containerEl).setName(label)
        .addExtraButton((button) => button.setIcon("x").setTooltip(t("settings.removeFilter", { rule: label }))
          .setDisabled(this.changingKey)
          .onClick(() => { void this.change({ propertyFilters: propertyFilters.filter((entry) => entry !== filter) }); }));
    }
  }

  override hide(): void {
    this.open = false;
    this.request++;
    delete this.statusEl;
  }

  renderStatus(): void {
    if (!this.statusEl) return;
    const { busy, status, translate: t } = this.plugin;
    this.statusEl.empty();
    if (busy) renderMessage(this.statusEl, { text: t("status.syncing"), tone: "info" });
    const time = status.lastSuccess ? this.plugin.formatSyncTime(status.lastSuccess) : t("status.never");
    renderMessage(this.statusEl, {
      text: t("status.lastSuccess", { time }),
      tone: status.lastSuccess ? "success" : "info",
    });
    const error = this.plugin.syncErrorText();
    if (error) renderMessage(this.statusEl, { text: error, tone: "error" });
  }

  private async change(next: Parameters<LangdockSyncPlugin["updateSettings"]>[0]): Promise<void> {
    try {
      await this.plugin.updateSettings(next);
    } catch (error) {
      this.plugin.notify(formatIssue(this.plugin.translate, issueFromError(error)));
    }
    if (this.open) this.display();
  }

  private async changeLanguage(preference: LanguagePreference): Promise<void> {
    try {
      await this.plugin.updateLanguage(preference);
    } catch (error) {
      this.plugin.notify(formatIssue(this.plugin.translate, issueFromError(error)));
    }
    if (this.open) this.display();
  }

  private async saveApiKey(value: string): Promise<void> {
    if (this.changingKey) return;
    if (!value.trim()) {
      this.plugin.notify(this.plugin.translate("errors.keyRequired"));
      return;
    }
    this.changingKey = true;
    this.request++;
    this.targets = [];
    this.connectionMessage = null;
    this.display();
    try {
      await this.plugin.updateApiKey(value);
    } catch (error) {
      const issue = issueFromError(error);
      this.plugin.notify(formatIssue(this.plugin.translate, issue));
      if (this.open) this.connectionMessage = { ...issue, tone: "error" };
    } finally {
      this.changingKey = false;
    }
    if (!this.open) return;
    if (this.connectionMessage) this.display();
    else await this.refreshFolders(false);
  }

  private async refreshFolders(test: boolean): Promise<void> {
    const request = ++this.request;
    this.connectionMessage = { key: "status.connecting", tone: "info" };
    this.display();
    try {
      const folders = await this.plugin.discoverFolders(test);
      if (!this.open || this.request !== request) return;
      this.targets = folders;
      if (!folders.length) {
        this.connectionMessage = { key: "status.targetsEmpty", tone: "info" };
      } else {
        this.connectionMessage = test ? { key: "status.connectionSuccess", tone: "success" } : null;
      }
    } catch (error) {
      if (!this.open || this.request !== request) return;
      this.targets = [];
      this.connectionMessage = { ...issueFromError(error), tone: "error" };
    }
    this.display();
  }
}

export class PreviewModal extends Modal {
  constructor(app: App, private readonly plan: Plan, private readonly translate: Translator) {
    super(app);
  }

  override onOpen(): void {
    const t = this.translate;
    this.setTitle(t("preview.title"));
    const { transfers, removals } = this.plan;
    if (!transfers.length && !removals.length) {
      this.contentEl.createEl("p", { text: t("preview.empty") });
      return;
    }
    const list = this.contentEl.createEl("ul");
    for (const { note, versions, pending, failed } of transfers) {
      const action = t(versions.length ? "preview.update" : "preview.upload", { path: note.path });
      const detail = pending ? t("preview.indexing") : failed ? t("preview.retryIndexing") : "";
      list.createEl("li", { text: detail ? t("preview.withDetail", { action, detail }) : action });
    }
    for (const { file, path } of removals) {
      list.createEl("li", { text: path ? t("preview.deleteOld", { path }) : t("preview.delete", { name: file.name }) });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
