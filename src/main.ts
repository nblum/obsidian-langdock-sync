import { getLanguage, Notice, Plugin, requestUrl, TFolder } from "obsidian";
import type { App, Command, Modal, TAbstractFile } from "obsidian";
import { apiKeySecretId, emptyStatus, findFolderMapping, isLangdockId, isVisiblePath, readData } from "./config.ts";
import type { Settings, SyncStatus } from "./config.ts";
import { AboutModal, IntroductionModal } from "./help.ts";
import { createTranslator, formatIssue, issueFromError, resolveLanguage } from "./i18n.ts";
import type { Issue, Language, LanguagePreference, TranslationKey } from "./i18n.ts";
import { Langdock, SyncError } from "./langdock.ts";
import type { Folder, ManagedFile } from "./langdock.ts";
import { NoteSyncControls } from "./note-sync-controls.ts";
import { IncompleteInventory, inventory, isCandidate, isFolderMetadata, readSyncFile } from "./notes.ts";
import type { SyncFile } from "./notes.ts";
import { LangdockSettingTab, PreviewModal } from "./settings.ts";
import { applyPlan, applyTargetPlans, planSingleFile, planSync, StaleRun } from "./sync.ts";
import type { TargetPlan } from "./sync.ts";

const debounceMs = 1_200;
const firstRetryMs = 30_000;

function clearTargets(settings: Settings): Settings {
  return { ...settings, automatic: false, folderMappings: settings.folderMappings.map(({ path }) => ({ path, folderId: "" })) };
}

export default class LangdockSyncPlugin extends Plugin {
  config!: Settings;
  status: SyncStatus = emptyStatus;
  busy = false;
  languagePreference: LanguagePreference = "auto";
  translate = createTranslator("en");
  showNoteSyncButton = true;

  private language: Language = "en";
  private readonly localizedCommands = new Map<Command, TranslationKey>();
  private helpDialog?: Modal;
  private previewDialog?: PreviewModal;
  private noteControls?: NoteSyncControls;
  private introductionSeen = false;
  private targetNames = new Map<string, string>();
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
    const { settings, status, targetNames, legacySecretId, language, introductionSeen, showNoteSyncButton } =
      readData(await this.loadData() as unknown);
    this.config = settings;
    this.status = status;
    this.targetNames = targetNames;
    this.introductionSeen = introductionSeen;
    this.showNoteSyncButton = showNoteSyncButton;
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
      const { vault, workspace } = this.app;
      const noteControls = new NoteSyncControls(this);
      this.noteControls = noteControls;
      this.registerEvent(workspace.on("file-open", () => noteControls.refresh(true)));
      this.registerEvent(workspace.on("layout-change", () => noteControls.refresh()));
      this.registerEvent(vault.on("create", (file) => this.onVaultChange(file)));
      this.registerEvent(vault.on("modify", (file) => this.onVaultChange(file)));
      this.registerEvent(vault.on("rename", (file, oldPath) => this.onVaultChange(file, oldPath)));
      this.registerEvent(vault.on("delete", (file) => this.onVaultChange(file)));
      this.registerDomEvent(window, "online", () => {
        this.schedule(0);
        noteControls.refresh(true);
      });
      noteControls.refresh();
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
    this.noteControls?.dispose();
  }

  private addLocalizedCommand(id: string, key: TranslationKey, callback: () => void): void {
    const command = this.addCommand({ id, name: this.translate(key), callback });
    this.localizedCommands.set(command, key);
  }

  showAbout(): void {
    this.openHelpDialog(new AboutModal(this.app, this.translate, this.manifest));
  }

  showIntroduction(): void {
    this.openHelpDialog(new IntroductionModal(this.app, this.translate, () => { void this.openSettings(); }));
    if (this.introductionSeen) return;
    this.introductionSeen = true;
    void this.persist().catch(() => {
      if (!this.stopped) this.notify(this.translate("errors.settingsSave"));
    });
  }

  private async openSettings(): Promise<void> {
    // Obsidian's settings controller is internal and can differ across versions.
    const { setting } = this.app as App & { setting?: {
      open?: () => Promise<void> | void;
      openTabById?: (id: string) => Promise<void> | void;
    } };
    if (typeof setting?.open !== "function" || typeof setting.openTabById !== "function") return;

    try {
      await setting.open();
      await setting.openTabById(this.manifest.id);
    } catch (error) {
      console.warn("Langdock Sync could not open its settings", error);
    }
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
    this.noteControls?.refresh();
    try {
      await this.persist();
    } catch {
      throw new SyncError("errors.settingsSave");
    }
  }

  async updateNoteSyncButton(enabled: boolean): Promise<void> {
    if (this.showNoteSyncButton === enabled) return;
    this.showNoteSyncButton = enabled;
    this.noteControls?.refresh();
    try {
      await this.persist();
    } catch {
      if (this.showNoteSyncButton === enabled) {
        this.showNoteSyncButton = !enabled;
        this.noteControls?.refresh();
      }
      throw new SyncError("errors.settingsSave");
    }
  }

  formatSyncTime(timestamp: string | number): string {
    return new Date(timestamp).toLocaleString(this.language);
  }

  syncErrorText(): string | null {
    return this.status.issues.length ? this.status.issues.map((issue) => formatIssue(this.translate, issue)).join("\n") : null;
  }

  notify(message: string): void {
    new Notice(this.translate("notice.prefix", { message }));
  }

  private onVaultChange(file: TAbstractFile, oldPath = file.path): void {
    const extensions = this.config.attachmentExtensions.split(",").filter(Boolean);
    const relevantPath = file instanceof TFolder ? isVisiblePath : (path: string) => isCandidate(path, extensions)
      || (extensions.length > 0 && isVisiblePath(path) && isFolderMetadata(path));
    if (!relevantPath(file.path) && !relevantPath(oldPath)) return;
    this.revision++;
    this.retryDelay = firstRetryMs;
    this.schedule(debounceMs);
    this.noteControls?.refresh();
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
          this.config = clearTargets(this.config);
          this.targetNames.clear();
          this.status = emptyStatus;
        }
      }
      await this.persist();
    } catch {
      this.config = { ...this.config, automatic: false, syncIntervalMinutes: 0 };
      this.status = { ...this.status, issues: [{ key: "errors.keyMigration" }] };
    }
  }

  hasApiKey(): boolean {
    return Boolean(this.storedKey());
  }

  private canScheduleSync(settings: Settings): boolean {
    return this.hasApiKey() && settings.folderMappings.length > 0
      && settings.folderMappings.every(({ folderId }) => isLangdockId(folderId));
  }

  async updateApiKey(value: string): Promise<void> {
    const key = value.trim();
    if (!key) throw new SyncError("errors.keyRequired");
    if (key === this.storedKey()) return;
    this.status = emptyStatus;
    this.targetNames.clear();
    await this.saveSettings(clearTargets(this.config));
    try {
      this.app.secretStorage.setSecret(apiKeySecretId, key);
    } catch {
      throw new SyncError("errors.keySave");
    }
  }

  async updateSettings(next: Partial<Settings>): Promise<void> {
    const previous = this.config;
    const settings = { ...previous, ...next };
    if (settings.folderMappings !== previous.folderMappings) {
      settings.automatic = false;
      this.status = emptyStatus;
    }
    if (!this.canScheduleSync(settings)) settings.automatic = false;
    if (settings.folderMappings === previous.folderMappings && settings.automatic === previous.automatic
      && settings.syncIntervalMinutes === previous.syncIntervalMinutes
      && settings.propertyFilters === previous.propertyFilters
      && settings.attachmentExtensions === previous.attachmentExtensions) return;
    try {
      await this.saveSettings(settings);
    } finally {
      this.tab?.refreshSettings();
    }
  }

  private async saveSettings(settings: Settings): Promise<void> {
    this.config = settings;
    this.noteControls?.refresh(true);
    this.retryDelay = firstRetryMs;
    this.automaticDue = false;
    this.clearTimer();
    this.clearSyncInterval();
    try {
      await this.persist();
    } catch {
      if (this.config === settings) {
        this.config = { ...settings, automatic: false, syncIntervalMinutes: 0 };
        this.noteControls?.refresh(true);
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
    const targetNames = Object.fromEntries(this.config.folderMappings.flatMap(({ folderId }) => {
      const name = this.targetNames.get(folderId);
      return name ? [[folderId, name] as const] : [];
    }));
    const data = {
      ...this.config,
      ...this.status,
      targetNames,
      language: this.languagePreference,
      introductionSeen: this.introductionSeen,
      showNoteSyncButton: this.showNoteSyncButton,
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
    const { syncIntervalMinutes } = this.config;
    if (this.intervalTimer !== undefined || !this.ready || this.stopped || !syncIntervalMinutes
      || !this.canScheduleSync(this.config)) return;
    this.intervalTimer = window.setInterval(() => {
      if (this.timer !== undefined || this.automaticJob || this.manualJob) return;
      this.runAutomaticSync();
    }, syncIntervalMinutes * 60_000);
  }

  private schedule(delay: number): void {
    if (!this.ready || this.stopped || !this.config.automatic) return;
    this.clearTimer();
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.runAutomaticSync();
    }, delay);
  }

  private runAutomaticSync(): void {
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
  }

  private retrySoon(): void {
    if (!this.config.automatic || this.timer !== undefined || this.automaticDue) return;
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
    const key = this.secret();
    const client = new Langdock(key, requestUrl);
    const folders = await client.folders();
    if (testTarget) {
      const ids = new Set(settings.folderMappings.map(({ folderId }) => folderId).filter(isLangdockId));
      for (const folderId of ids) await client.managedFiles(folderId, folders);
    }
    if (this.stopped || this.storedKey() !== key) throw new StaleRun();
    return folders;
  }

  savedTargetName(folderId: string): string | undefined {
    return this.targetNames.get(folderId);
  }

  async rememberTargetNames(folders: readonly Folder[]): Promise<void> {
    const assignedIds = new Set(this.config.folderMappings.map(({ folderId }) => folderId));
    let hasAssignedName = false;
    for (const { id, name } of folders) {
      if (!name.trim()) continue;
      this.targetNames.set(id, name);
      hasAssignedName ||= assignedIds.has(id);
    }
    if (hasAssignedName) {
      try {
        await this.persist();
      } catch {
        throw new SyncError("errors.settingsSave");
      }
    }
  }

  private syncConnection(settings: Settings) {
    if (!this.ready || this.stopped) throw new SyncError("errors.vaultNotReady");
    if (this.config !== settings) throw new StaleRun();
    if (!settings.folderMappings.length) throw new SyncError("errors.folderRequired");
    const key = this.secret();
    const assertConnection = () => {
      if (this.stopped || this.config !== settings || this.storedKey() !== key) {
        throw new StaleRun();
      }
    };
    return { client: new Langdock(key, requestUrl), assertConnection };
  }

  private startRun(settings: Settings) {
    const { client, assertConnection } = this.syncConnection(settings);
    const revision = this.revision;
    const assertCurrent = () => {
      assertConnection();
      if (this.revision !== revision) throw new StaleRun();
    };
    return { client, assertCurrent };
  }

  async readEligibleFile(path: string, settings: Settings): Promise<{ file: SyncFile; folderId: string } | null> {
    const mapping = findFolderMapping(path, settings.folderMappings);
    if (!mapping || !isLangdockId(mapping.folderId) || !isCandidate(path, settings.attachmentExtensions.split(","))
      || !this.app.vault.getFileByPath(path)) return null;
    const result = await readSyncFile(this.app.vault.adapter, path, settings.propertyFilters);
    return result ? { file: result.file, folderId: mapping.folderId } : null;
  }

  async readManagedFiles(settings: Settings, folderId: string): Promise<ManagedFile[]> {
    return this.enqueue(async () => {
      const { client, assertConnection } = this.syncConnection(settings);
      const files = await client.managedFiles(folderId);
      assertConnection();
      return files;
    });
  }

  async syncFile(path: string): Promise<Issue | undefined> {
    const settings = this.config;
    return this.enqueue(async () => {
      const { client, assertCurrent } = this.startRun(settings);
      const routed = await this.readEligibleFile(path, settings);
      if (!routed) throw new SyncError("errors.noteIneligible");
      const { file, folderId } = routed;
      assertCurrent();
      const remote = await client.managedFiles(folderId);
      const plan = planSingleFile(file, remote);
      const report = await applyPlan(plan, this.app.vault.adapter, client, { ...settings, folderId }, true, assertCurrent);
      return report.issues[0];
    });
  }

  private async prepare(settings: Settings): Promise<{
    plans: TargetPlan[];
    client: Langdock;
    assertCurrent: () => void;
  }> {
    const { client, assertCurrent } = this.startRun(settings);
    if (settings.folderMappings.some(({ folderId }) => !isLangdockId(folderId))) throw new SyncError("errors.targetRequired");
    const { vault } = this.app;
    const scope = { ...settings, folders: settings.folderMappings.map(({ path }) => path) };
    const files = await inventory(vault.adapter, vault.getFiles().map(({ path }) => path), scope, assertCurrent);
    const byTarget = new Map(settings.folderMappings.map(({ folderId }) => [folderId, new Map<string, SyncFile>()]));
    for (const [hash, file] of files) {
      const mapping = findFolderMapping(file.path, settings.folderMappings);
      const targetFiles = mapping && byTarget.get(mapping.folderId);
      if (!targetFiles) throw new StaleRun();
      targetFiles.set(hash, file);
    }
    const folders = await client.folders();
    const plans: TargetPlan[] = [];
    for (const [folderId, local] of byTarget) {
      assertCurrent();
      const remote = await client.managedFiles(folderId, folders);
      const name = folders.find(({ id }) => id === folderId)?.name ?? folderId;
      plans.push({ target: { id: folderId, name }, plan: planSync(local, remote, files) });
    }
    assertCurrent();
    return { plans, client, assertCurrent };
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
        const { plans, assertCurrent } = await this.prepare(settings);
        if (this.previewDialog !== dialog) return;
        assertCurrent();
        dialog.showPlans(plans);
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
      if (this.stopped || this.config !== settings) return;
      this.busy = true;
      this.tab?.renderStatus();

      let issues: Issue[];
      let retry: boolean;
      try {
        const { plans, client, assertCurrent } = await this.prepare(settings);
        const report = await applyTargetPlans(plans, this.app.vault.adapter, client, settings, manual, assertCurrent);
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
        this.noteControls?.refresh(true);
      }
    });
  }
}
