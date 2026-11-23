import { getLanguage, Notice, Plugin, requestUrl, TFolder } from "obsidian";
import type { Command, Modal, TAbstractFile } from "obsidian";
import { apiKeySecretId, emptyStatus, isVisiblePath, readData } from "./config.ts";
import type { Settings, SyncStatus } from "./config.ts";
import { AboutModal, IntroductionModal } from "./help.ts";
import { createTranslator, formatIssue, issueFromError, resolveLanguage } from "./i18n.ts";
import type { Issue, Language, LanguagePreference, TranslationKey } from "./i18n.ts";
import { isId, Langdock, SyncError } from "./langdock.ts";
import type { Folder } from "./langdock.ts";
import { IncompleteInventory, inventory, isCandidate } from "./notes.ts";
import { LangdockSettingTab, PreviewModal } from "./settings.ts";
import { applyPlan, planSync, StaleRun } from "./sync.ts";
import type { Plan } from "./sync.ts";

const debounceMs = 1_200;
const firstRetryMs = 30_000;

export default class LangdockSyncPlugin extends Plugin {
  config!: Settings;
  status: SyncStatus = emptyStatus;
  busy = false;
  languagePreference: LanguagePreference = "auto";
  translate = createTranslator("en");

  private language: Language = "en";
  private readonly localizedCommands = new Map<Command, TranslationKey>();
  private helpDialog?: Modal;
  private previewDialog?: PreviewModal;
  private introductionSeen = false;
  private tab?: LangdockSettingTab;
  private ready = false;
  private stopped = false;
  private revision = 0;
  private timer: number | undefined;
  private intervalTimer: number | undefined;
  private retryDelay = firstRetryMs;
  private automaticJob = false;
  private automaticDue = false;
  private manualJob: Promise<void> | undefined;
  private queue = Promise.resolve();
  private saveQueue = Promise.resolve();

  override async onload(): Promise<void> {
    const { settings, status, legacySecretId, language, introductionSeen } = readData(await this.loadData() as unknown);
    this.config = settings;
    this.status = status;
    this.introductionSeen = introductionSeen;
    this.setLanguage(language);
    if (legacySecretId !== null) await this.migrateSecret(legacySecretId);
    this.tab = new LangdockSettingTab(this);
    this.addSettingTab(this.tab);
    this.addLocalizedCommand("preview-sync", "commands.preview", () => { void this.showPreview(); });
    this.addLocalizedCommand("sync-now", "commands.syncNow", () => { void this.syncNow(); });
    this.addLocalizedCommand("show-about", "commands.showAbout", () => { this.showAbout(); });
    this.addLocalizedCommand("show-introduction", "commands.showIntroduction", () => { this.showIntroduction(); });

    this.app.workspace.onLayoutReady(() => {
      if (this.stopped) return;
      this.ready = true;
      if (!this.introductionSeen) this.showIntroduction();
      const { vault } = this.app;
      this.registerEvent(vault.on("create", (file) => this.onVaultChange(file)));
      this.registerEvent(vault.on("modify", (file) => this.onVaultChange(file)));
      this.registerEvent(vault.on("rename", (file, oldPath) => this.onVaultChange(file, oldPath)));
      this.registerEvent(vault.on("delete", (file) => this.onVaultChange(file)));
      this.registerDomEvent(window, "online", () => this.schedule(0));
      this.schedule(debounceMs);
      this.startSyncInterval();
    });
  }

  override onunload(): void {
    this.stopped = true;
    this.clearTimer();
    this.clearSyncInterval();
    this.helpDialog?.close();
    this.previewDialog?.close();
  }

  private addLocalizedCommand(id: string, key: TranslationKey, callback: () => void): void {
    const command = this.addCommand({ id, name: this.translate(key), callback });
    this.localizedCommands.set(command, key);
  }

  showAbout(): void {
    this.openHelpDialog(new AboutModal(this.app, this.translate, this.manifest));
  }

  showIntroduction(): void {
    this.openHelpDialog(new IntroductionModal(this.app, this.translate));
    if (this.introductionSeen) return;
    this.introductionSeen = true;
    void this.persist().catch(() => {
      if (!this.stopped) this.notify(this.translate("errors.settingsSave"));
    });
  }

  private openHelpDialog(dialog: Modal): void {
    const previous = this.helpDialog;
    this.helpDialog = dialog;
    previous?.close();
    dialog.setCloseCallback(() => {
      if (this.helpDialog === dialog) delete this.helpDialog;
    }).open();
  }

  private setLanguage(preference: LanguagePreference): void {
    this.languagePreference = preference;
    this.language = resolveLanguage(preference, getLanguage());
    this.translate = createTranslator(this.language);
    for (const [command, key] of this.localizedCommands) {
      command.name = `${this.manifest.name}: ${this.translate(key)}`;
    }
  }

  async updateLanguage(preference: LanguagePreference): Promise<void> {
    if (preference === this.languagePreference) return;
    this.setLanguage(preference);
    try {
      await this.persist();
    } catch {
      throw new SyncError("errors.settingsSave");
    }
  }

  formatSyncTime(timestamp: string): string {
    return new Date(timestamp).toLocaleString(this.language);
  }

  syncErrorText(): string | null {
    return this.status.issues.length ? this.status.issues.map((issue) => formatIssue(this.translate, issue)).join("\n") : null;
  }

  notify(message: string): void {
    new Notice(this.translate("notice.prefix", { message }));
  }

  private onVaultChange(file: TAbstractFile, oldPath = file.path): void {
    const relevantPath = file instanceof TFolder ? isVisiblePath : isCandidate;
    if (!relevantPath(file.path) && !relevantPath(oldPath)) return;
    this.revision++;
    this.retryDelay = firstRetryMs;
    this.schedule(debounceMs);
  }

  private async migrateSecret(previousId: string): Promise<void> {
    try {
      if (previousId && previousId !== apiKeySecretId) {
        const previousKey = this.app.secretStorage.getSecret(previousId)?.trim();
        const fixedKey = this.storedKey();
        if (!fixedKey && previousKey) {
          this.app.secretStorage.setSecret(apiKeySecretId, previousKey);
        } else if (fixedKey !== previousKey) {
          // An existing fixed entry may belong to a different Langdock workspace.
          this.config = { ...this.config, folderId: "", automatic: false };
          this.status = emptyStatus;
        }
      }
      await this.persist();
    } catch {
      this.config = { ...this.config, automatic: false };
      this.status = { ...this.status, issues: [{ key: "errors.keyMigration" }] };
    }
  }

  hasApiKey(): boolean {
    return Boolean(this.storedKey());
  }

  async updateApiKey(value: string): Promise<void> {
    const key = value.trim();
    if (!key) throw new SyncError("errors.keyRequired");
    if (key === this.storedKey()) return;
    this.status = emptyStatus;
    await this.saveSettings({ ...this.config, folderId: "", automatic: false });
    try {
      this.app.secretStorage.setSecret(apiKeySecretId, key);
    } catch {
      throw new SyncError("errors.keySave");
    }
  }

  async updateSettings(next: Partial<Settings>): Promise<void> {
    const previous = this.config;
    const settings = { ...previous, ...next };
    if (settings.folderId !== previous.folderId) {
      settings.automatic = false;
      this.status = emptyStatus;
    }
    if (!this.hasApiKey() || !isId(settings.folderId) || !settings.folders.length) settings.automatic = false;
    if (settings.folderId === previous.folderId && settings.automatic === previous.automatic
      && settings.syncIntervalMinutes === previous.syncIntervalMinutes
      && settings.folders === previous.folders && settings.propertyFilters === previous.propertyFilters) return;
    try {
      await this.saveSettings(settings);
    } finally {
      this.tab?.refreshSettings();
    }
  }

  private async saveSettings(settings: Settings): Promise<void> {
    this.config = settings;
    this.retryDelay = firstRetryMs;
    this.automaticDue = false;
    this.clearTimer();
    this.clearSyncInterval();
    try {
      await this.persist();
    } catch {
      if (this.config === settings) {
        this.config = { ...settings, automatic: false };
        this.clearSyncInterval();
        this.status = { ...this.status, issues: [{ key: "errors.settingsSave" }] };
        this.tab?.renderStatus();
      }
      throw new SyncError("errors.settingsSave");
    }
    if (this.config === settings) {
      this.schedule(debounceMs);
      this.startSyncInterval();
    }
  }

  private persist(): Promise<void> {
    const data = {
      ...this.config,
      ...this.status,
      language: this.languagePreference,
      introductionSeen: this.introductionSeen,
    };
    const saved = this.saveQueue.then(() => this.saveData(data));
    this.saveQueue = saved.catch(() => {});
    return saved;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private clearSyncInterval(): void {
    if (this.intervalTimer !== undefined) window.clearInterval(this.intervalTimer);
    this.intervalTimer = undefined;
  }

  private startSyncInterval(): void {
    const { automatic, syncIntervalMinutes } = this.config;
    if (this.intervalTimer !== undefined || !this.ready || this.stopped || !automatic || !syncIntervalMinutes) return;
    this.intervalTimer = window.setInterval(() => {
      if (this.timer !== undefined || this.automaticJob || this.manualJob) return;
      this.schedule(0);
    }, syncIntervalMinutes * 60_000);
  }

  private schedule(delay: number): void {
    if (!this.ready || this.stopped || !this.config.automatic) return;
    this.clearTimer();
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      if (this.automaticJob) {
        this.automaticDue = true;
        return;
      }
      this.automaticJob = true;
      void this.sync(false).finally(() => {
        this.automaticJob = false;
        if (this.automaticDue) {
          this.automaticDue = false;
          if (this.timer === undefined) this.schedule(0);
        }
      });
    }, delay);
  }

  private retrySoon(): void {
    if (this.timer !== undefined || this.automaticDue) return;
    this.schedule(this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 300_000);
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.queue.then(job);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  private storedKey(): string | undefined {
    return this.app.secretStorage.getSecret(apiKeySecretId)?.trim() || undefined;
  }

  private secret(): string {
    const key = this.storedKey();
    if (!key) throw new SyncError("errors.keyMissing");
    return key;
  }

  async discoverFolders(testTarget: boolean): Promise<Folder[]> {
    const settings = this.config;
    const client = new Langdock(this.secret(), requestUrl);
    const folders = await client.folders();
    if (testTarget && settings.folderId) await client.managedFiles(settings.folderId, folders);
    return folders;
  }

  private async prepare(settings: Settings): Promise<{
    plan: Plan;
    client: Langdock;
    assertCurrent: () => void;
  }> {
    if (!this.ready || this.stopped) throw new SyncError("errors.vaultNotReady");
    if (this.config !== settings) throw new StaleRun();
    if (!settings.folders.length) throw new SyncError("errors.folderRequired");
    const key = this.secret();
    if (!isId(settings.folderId)) throw new SyncError("errors.targetRequired");
    const revision = this.revision;
    const assertCurrent = () => {
      if (this.stopped || this.config !== settings || this.revision !== revision
        || this.storedKey() !== key) {
        throw new StaleRun();
      }
    };
    const { vault } = this.app;
    const notes = await inventory(vault.adapter, vault.getFiles().map(({ path }) => path), settings, assertCurrent);
    const client = new Langdock(key, requestUrl);
    const remote = await client.managedFiles(settings.folderId);
    assertCurrent();
    return { plan: planSync(notes, remote), client, assertCurrent };
  }

  async showPreview(): Promise<void> {
    if (this.stopped || this.previewDialog) return;
    const settings = this.config;
    const dialog = new PreviewModal(this.app, this.translate);
    this.previewDialog = dialog;
    dialog.setCloseCallback(() => {
      if (this.previewDialog === dialog) delete this.previewDialog;
    }).open();

    try {
      await this.enqueue(async () => {
        if (this.previewDialog !== dialog) return;
        const { plan, assertCurrent } = await this.prepare(settings);
        if (this.previewDialog !== dialog) return;
        assertCurrent();
        dialog.showPlan(plan);
      });
    } catch (error) {
      if (this.previewDialog === dialog) dialog.showError(issueFromError(error));
    }
  }

  syncNow(): Promise<void> {
    this.manualJob ??= this.sync(true).finally(() => { this.manualJob = undefined; });
    return this.manualJob;
  }

  private sync(manual: boolean): Promise<void> {
    const settings = this.config;
    return this.enqueue(async () => {
      if (this.stopped || this.config !== settings || (!manual && !settings.automatic)) return;
      this.busy = true;
      this.tab?.renderStatus();

      let issues: Issue[];
      let retry: boolean;
      try {
        const { plan, client, assertCurrent } = await this.prepare(settings);
        const report = await applyPlan(plan, this.app.vault.adapter, client, settings, manual, assertCurrent);
        issues = report.issues;
        retry = report.retry;
      } catch (error) {
        issues = [issueFromError(error)];
        retry = error instanceof StaleRun || error instanceof IncompleteInventory || (error instanceof SyncError && error.retry);
      }

      try {
        if (this.stopped || this.config !== settings) return;
        this.status = {
          lastSuccess: issues.length ? this.status.lastSuccess : new Date().toISOString(),
          issues,
        };
        await this.persist();
        if (this.stopped || this.config !== settings) return;
        if (retry) this.retrySoon();
        else this.retryDelay = firstRetryMs;
        if (manual) this.notify(this.translate(issues.length ? "status.syncFailed" : "status.syncSuccess"));
      } catch {
        if (!this.stopped && this.config === settings) {
          this.status = { ...this.status, issues: [{ key: "errors.statusSave" }] };
          if (manual) this.notify(this.translate("errors.statusSave"));
        }
      } finally {
        this.busy = false;
        this.tab?.renderStatus();
      }
    });
  }
}
