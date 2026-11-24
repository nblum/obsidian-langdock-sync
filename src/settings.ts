import { Modal, PluginSettingTab, requireApiVersion, Setting } from "obsidian";
import type { App, SettingDefinitionRender } from "obsidian";
import { isVisiblePath, syncIntervals } from "./config.ts";
import { supportedAttachmentExtensions } from "./file-formats.ts";
import { renderAbout } from "./help.ts";
import { formatIssue, isLanguagePreference, issueFromError, languageNames } from "./i18n.ts";
import type { Issue, LanguagePreference, TranslationKey, Translator } from "./i18n.ts";
import { isId } from "./langdock.ts";
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

type SettingsRow = Pick<SettingDefinitionRender, "name" | "desc" | "aliases" | "searchable"> & {
  render: (setting: Setting) => void | (() => void);
};

function heading(name: string): SettingsRow {
  return { name, render: (setting) => { setting.setHeading(); } };
}

function contentRow(render: (container: HTMLElement) => void): SettingsRow {
  return {
    name: "",
    searchable: false,
    render: (setting) => {
      setting.setClass("langdock-sync-content-row");
      const content = setting.settingEl.createDiv();
      render(content);
      return () => {
        content.remove();
        setting.settingEl.removeClass("langdock-sync-content-row");
      };
    },
  };
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

  override getSettingDefinitions(): SettingsRow[] {
    const { manifest, translate: t } = this.plugin;
    const connectionMessage = this.connectionMessage;
    return [
      {
        name: manifest.name,
        searchable: false,
        render: (setting) => {
          setting.setClass("langdock-sync-settings-header").setHeading();
          renderAbout(setting.descEl, t, manifest);
        },
      },
      {
        name: t("language.label"),
        desc: t("language.help"),
        render: (setting) => {
          setting.addDropdown((dropdown) => {
            dropdown.selectEl.setAttribute("aria-label", t("language.label"));
            dropdown.addOption("auto", t("language.auto"))
              .addOptions(languageNames)
              .setValue(this.plugin.languagePreference)
              .setDisabled(this.changingKey)
              .onChange((value) => {
                if (isLanguagePreference(value)) void this.changeLanguage(value);
              });
          });
        },
      },
      {
        name: t("commands.showIntroduction"),
        aliases: [t("commands.showAbout")],
        render: (setting) => {
          setting.setName("").setClass("langdock-sync-controls")
            .addButton((button) => button.setButtonText(t("commands.showIntroduction"))
              .onClick(() => { this.plugin.showIntroduction(); }))
            .addButton((button) => button.setButtonText(t("commands.showAbout"))
              .onClick(() => { this.plugin.showAbout(); }));
        },
      },
      heading(t("settings.connection")),
      {
        name: t("settings.apiKey"),
        desc: t("settings.keyStorage"),
        aliases: [t("settings.saveKey")],
        render: (setting) => {
          let keyInput: HTMLInputElement;
          setting.setDesc(this.hasUsableKey() ? t("settings.keySet") : t("settings.keyStorage"))
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
        },
      },
      contentRow((container) => {
        appendLinkedHelp(
          container.createEl("p", { cls: "langdock-sync-help" }),
          t("settings.workspaceKeyHelp", { scope: "KNOWLEDGE_FOLDER_API" }),
          t("settings.workspaceApiLink"),
          "https://app.langdock.com/settings/workspace/products/api",
        );
      }),
      {
        name: t("settings.knowledgeBase"),
        desc: t("settings.editorHelp"),
        render: (setting) => {
          const { folderId } = this.plugin.config;
          setting.addDropdown((dropdown) => {
            dropdown.selectEl.setAttribute("aria-label", t("settings.knowledgeBase"));
            dropdown.addOption("", t("settings.select"));
            if (folderId && !this.targets.some(({ id }) => id === folderId)) {
              dropdown.addOption(folderId, t("settings.savedTarget", { id: folderId }));
              dropdown.selectEl.options[dropdown.selectEl.options.length - 1]?.setAttribute("disabled", "");
            }
            for (const folder of this.targets) {
              dropdown.addOption(folder.id, folder.role === "EDITOR" ? folder.name : t("settings.readOnlyTarget", { name: folder.name }));
              if (folder.role !== "EDITOR") {
                dropdown.selectEl.options[dropdown.selectEl.options.length - 1]?.setAttribute("disabled", "");
              }
            }
            dropdown.setDisabled(this.changingKey).setValue(folderId).onChange((nextFolderId) => {
              if (nextFolderId && !this.targets.some(({ id, role }) => id === nextFolderId && role === "EDITOR")) return;
              this.request++;
              this.connectionMessage = null;
              void this.change({ folderId: nextFolderId });
            });
          });
        },
      },
      {
        name: t("settings.loadTargets"),
        aliases: [t("settings.testConnection")],
        render: (setting) => {
          const hasApiKey = this.hasUsableKey();
          setting.setName("").setClass("langdock-sync-controls")
            .addButton((button) => button.setButtonText(t("settings.loadTargets"))
              .setDisabled(!hasApiKey)
              .onClick(() => { void this.refreshFolders(false); }))
            .addButton((button) => button.setButtonText(t("settings.testConnection"))
              .setDisabled(!hasApiKey)
              .onClick(() => { void this.refreshFolders(true); }));
        },
      },
      ...(connectionMessage ? [contentRow((container) => {
        const { key, tone, variables } = connectionMessage;
        renderMessage(container, { text: t(key, variables), tone }).setAttribute("role", "status");
      })] : []),
      ...this.folderDefinitions(t),
      ...this.propertyDefinitions(t),
      {
        name: t("settings.attachmentExtensions"),
        desc: t("settings.attachmentExtensionsHelp"),
        aliases: [t("settings.saveAttachmentExtensions")],
        render: (setting) => {
          const selected = new Set(this.plugin.config.attachmentExtensions.split(","));
          setting.setClass("langdock-sync-attachments").setClass("langdock-sync-controls");
          const group = setting.controlEl.createDiv({
            cls: "langdock-sync-attachment-options",
            attr: { role: "group", "aria-label": t("settings.attachmentExtensions") },
          });
          const checkboxes = supportedAttachmentExtensions.map((extension) => {
            const label = group.createEl("label", { cls: "langdock-sync-attachment-option" });
            const checkbox = label.createEl("input", { attr: { type: "checkbox", value: extension } });
            checkbox.checked = selected.has(extension);
            checkbox.disabled = this.changingKey;
            label.append(`.${extension}`);
            return checkbox;
          });
          setting.addButton((button) => {
            button.setButtonText(t("settings.saveAttachmentExtensions")).setDisabled(true).onClick(() => {
              const attachmentExtensions = checkboxes.filter(({ checked }) => checked).map(({ value }) => value).join(",");
              void this.change({ attachmentExtensions });
            });
            group.addEventListener("change", () => {
              const changed = checkboxes.some(({ checked, value }) => checked !== selected.has(value));
              button.setDisabled(this.changingKey || !changed);
            });
          });
          return () => { group.remove(); };
        },
      },
      {
        name: t("settings.automatic"),
        desc: t("settings.automaticHelp"),
        render: (setting) => {
          setting.addToggle((toggle) => toggle.setDisabled(Boolean(this.syncDisabledReason()))
            .setValue(this.plugin.config.automatic)
            .onChange((automatic) => { void this.change({ automatic }); }));
        },
      },
      {
        name: t("settings.interval"),
        desc: t("settings.intervalHelp"),
        render: (setting) => {
          const { automatic, syncIntervalMinutes } = this.plugin.config;
          setting.addDropdown((dropdown) => {
            dropdown.selectEl.setAttribute("aria-label", t("settings.interval"));
            for (const minutes of syncIntervals) {
              dropdown.addOption(String(minutes), t(`settings.interval.${minutes}`));
            }
            dropdown.setValue(String(syncIntervalMinutes))
              .setDisabled(!automatic || Boolean(this.syncDisabledReason()))
              .onChange((value) => {
                const minutes = syncIntervals.find((interval) => String(interval) === value);
                if (minutes !== undefined) void this.change({ syncIntervalMinutes: minutes });
              });
          });
        },
      },
      {
        name: t("settings.noteSyncButton"),
        desc: t("settings.noteSyncButtonHelp"),
        render: (setting) => {
          setting.addToggle((toggle) => toggle.setValue(this.plugin.showNoteSyncButton)
            .onChange(async (enabled) => {
              try {
                await this.plugin.updateNoteSyncButton(enabled);
              } catch (error) {
                toggle.setValue(this.plugin.showNoteSyncButton);
                this.plugin.notify(formatIssue(t, issueFromError(error)));
              }
            }));
        },
      },
      {
        name: t("settings.sync"),
        aliases: [t("settings.preview"), t("commands.syncNow")],
        render: (setting) => {
          const reason = this.syncDisabledReason();
          setting.setDesc(reason ? t(reason) : "")
            .addButton((button) => button.setButtonText(t("settings.preview")).setDisabled(Boolean(reason))
              .onClick(() => { void this.plugin.showPreview(); }))
            .addButton((button) => button.setButtonText(t("commands.syncNow")).setCta().setDisabled(Boolean(reason))
              .onClick(() => { void this.plugin.syncNow(); }));
        },
      },
      contentRow((container) => {
        this.open = true;
        this.statusEl = container.createDiv({ cls: "langdock-sync-status", attr: { role: "status" } });
        this.renderStatus();
      }),
    ];
  }

  private hasUsableKey(): boolean {
    return !this.changingKey && this.plugin.hasApiKey();
  }

  private syncDisabledReason(): TranslationKey | undefined {
    const { folderId, folders } = this.plugin.config;
    if (this.changingKey) return "settings.keySaving";
    if (!this.plugin.hasApiKey()) return "errors.keyMissing";
    if (!isId(folderId)) return "errors.targetRequired";
    if (!folders.length) return "errors.folderRequired";
    return undefined;
  }

  private availableFolders(): string[] {
    return ["/", ...this.app.vault.getAllFolders(false).map(({ path }) => path)
      .filter(isVisiblePath).sort((left, right) => left.localeCompare(right))];
  }

  private folderDefinitions(t: Translator): SettingsRow[] {
    const { folders } = this.plugin.config;
    const folderName = (path: string) => path === "/" ? t("settings.vaultRoot") : path;
    return [
      heading(t("settings.manageFolders")),
      contentRow((container) => {
        container.createEl("p", { cls: "langdock-sync-help", text: t("settings.foldersHelp") });
      }),
      {
        name: t("settings.folderPicker"),
        aliases: [t("settings.addFolder")],
        render: (setting) => {
          setting.setName("").addDropdown((dropdown) => {
            dropdown.selectEl.setAttribute("aria-label", t("settings.folderPicker"));
            dropdown.addOption("", t("settings.addFolder"));
            for (const path of this.availableFolders()) {
              if (!folders.includes(path)) dropdown.addOption(path, folderName(path));
            }
            dropdown.setDisabled(this.changingKey).onChange((path) => {
              if (path) void this.change({ folders: [...folders, path] });
            });
          });
        },
      },
      ...folders.map((path): SettingsRow => ({
        name: "",
        searchable: false,
        render: (setting) => {
          const label = folderName(path);
          setting.setName(label);
          if (path !== "/" && !this.app.vault.getFolderByPath(path)) setting.setDesc(t("settings.folderMissing"));
          setting.addExtraButton((button) => button.setIcon("x").setTooltip(t("settings.removeFolder", { name: label }))
            .setDisabled(this.changingKey)
            .onClick(() => { void this.change({ folders: folders.filter((folder) => folder !== path) }); }));
        },
      })),
    ];
  }

  private propertyDefinitions(t: Translator): SettingsRow[] {
    const { propertyFilters } = this.plugin.config;
    return [
      heading(t("settings.manageProperties")),
      contentRow((container) => {
        const help = container.createEl("p", { cls: "langdock-sync-help" });
        help.createEl("strong", { text: t("settings.propertiesLogic") });
        help.createEl("br");
        for (const [index, part] of t("settings.propertiesExample").split("`").entries()) {
          if (index % 2 === 0) help.append(part);
          else help.createEl("code", { text: part });
        }
        help.createEl("br");
        appendLinkedHelp(help, t("settings.propertiesHelp"), "Classificator", "https://github.com/nblum/obsidian-classificator");
      }),
      {
        name: t("settings.addFilter"),
        aliases: [t("settings.propertyLabel"), t("settings.valueLabel")],
        render: (setting) => {
          let propertyInput: HTMLInputElement;
          let valueInput: HTMLInputElement;
          setting.setName("").setClass("langdock-sync-controls")
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
        },
      },
      ...propertyFilters.map((filter): SettingsRow => ({
        name: "",
        searchable: false,
        render: (setting) => {
          const label = `${filter.property} = ${filter.value}`;
          setting.setName(label)
            .addExtraButton((button) => button.setIcon("x").setTooltip(t("settings.removeFilter", { rule: label }))
              .setDisabled(this.changingKey)
              .onClick(() => { void this.change({ propertyFilters: propertyFilters.filter((entry) => entry !== filter) }); }));
        },
      })),
    ];
  }

  // Obsidian 1.12 calls display(); newer versions render the same definitions directly.
  override display(): void {
    this.renderLegacySettings();
  }

  refreshSettings(): void {
    if (requireApiVersion("1.13.0")) this.update();
    else if (this.open) this.renderLegacySettings();
  }

  private renderLegacySettings(): void {
    this.containerEl.empty();
    for (const { name, desc, render } of this.getSettingDefinitions()) {
      render(new Setting(this.containerEl).setName(name).setDesc(desc ?? ""));
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
  }

  private async changeLanguage(preference: LanguagePreference): Promise<void> {
    try {
      await this.plugin.updateLanguage(preference);
    } catch (error) {
      this.plugin.notify(formatIssue(this.plugin.translate, issueFromError(error)));
    }
    this.refreshSettings();
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
    this.refreshSettings();
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
    if (this.connectionMessage) this.refreshSettings();
    else await this.refreshFolders(false);
  }

  private async refreshFolders(test: boolean): Promise<void> {
    const request = ++this.request;
    this.connectionMessage = { key: "status.connecting", tone: "info" };
    this.refreshSettings();
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
    this.refreshSettings();
  }
}

export class PreviewModal extends Modal {
  constructor(app: App, private readonly translate: Translator) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.addClass("langdock-sync-preview");
    this.setTitle(this.translate("preview.title"));
    const loading = renderMessage(this.contentEl, { text: this.translate("preview.loading"), tone: "info" });
    loading.setAttribute("role", "status");
    loading.createEl("progress", {
      cls: "langdock-sync-preview-progress",
      attr: { "aria-hidden": "true" },
    });
  }

  showPlan({ transfers, removals }: Plan): void {
    const t = this.translate;
    this.contentEl.empty();
    if (!transfers.length && !removals.length) {
      this.contentEl.createEl("p", { text: t("preview.empty") });
      return;
    }
    const list = this.contentEl.createEl("ul");
    for (const { file, versions, pending, failed } of transfers) {
      const action = t(versions.length ? "preview.update" : "preview.upload", { path: file.path });
      const detail = pending ? t("preview.indexing") : failed ? t("preview.retryIndexing") : "";
      list.createEl("li", { text: detail ? t("preview.withDetail", { action, detail }) : action });
    }
    for (const { file, path } of removals) {
      list.createEl("li", { text: path ? t("preview.deleteOld", { path }) : t("preview.delete", { name: file.name }) });
    }
  }

  showError(issue: Issue): void {
    this.contentEl.empty();
    renderMessage(this.contentEl, { text: formatIssue(this.translate, issue), tone: "error" })
      .setAttribute("role", "alert");
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}
