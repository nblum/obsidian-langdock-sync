import { ButtonComponent, EditableFileView, Modal, setTooltip } from "obsidian";
import { formatIssue, issueFromError } from "./i18n.ts";
import type { Issue } from "./i18n.ts";
import { isId } from "./langdock.ts";
import type { ManagedFile } from "./langdock.ts";
import type LangdockSyncPlugin from "./main.ts";
import type { SyncFile } from "./notes.ts";
import { planSingleFile } from "./sync.ts";

type NoteState = "checking" | "unsynced" | "outdated" | "synced" | "unavailable" | "ineligible";
type RemoteInventory = { files: ManagedFile[] } | { issue: Issue };

interface NoteStatus {
  state: NoteState;
  issue?: Issue;
  uploadedAt?: number;
}

function noteStatus(file: SyncFile, remote: RemoteInventory): NoteStatus {
  if ("issue" in remote) return { state: "unavailable", issue: remote.issue };
  const { transfers: [transfer], versions } = planSingleFile(file, remote.files);
  const synced = !transfer;
  const indexed = versions.filter(({ status, contentHash }) => status === "SYNCED" && (!synced || contentHash === file.contentHash));
  const result: NoteStatus = { state: synced ? "synced" : indexed.length ? "outdated" : "unsynced" };
  for (const { createdAt } of indexed) {
    if (createdAt !== undefined && (result.uploadedAt === undefined || createdAt > result.uploadedAt)) result.uploadedAt = createdAt;
  }
  if (transfer?.pending) result.issue = { key: "errors.indexPending" };
  else if (transfer?.failed) result.issue = { key: "errors.indexFailed", variables: { status: transfer.failed.status } };
  return result;
}

class NoteSyncModal extends Modal {
  private statusEl?: HTMLElement;
  private uploadTimeEl?: HTMLTimeElement;
  private issueEl?: HTMLElement;
  private action?: ButtonComponent;
  actionIssue?: Issue;

  constructor(private readonly plugin: LangdockSyncPlugin, readonly path: string, private readonly sync: () => void) {
    super(plugin.app);
  }

  override onOpen(): void {
    this.modalEl.addClass("langdock-sync-note-dialog");
    this.contentEl.createEl("p", { cls: "langdock-sync-note-path", text: this.path });
    this.statusEl = this.contentEl.createEl("p", { cls: "langdock-sync-note-status", attr: { role: "status" } });
    this.uploadTimeEl = this.contentEl.createEl("time", { cls: "langdock-sync-note-upload-time" });
    this.issueEl = this.contentEl.createEl("p", { cls: "langdock-sync-note-issue", attr: { role: "status" } });
    this.action = new ButtonComponent(this.contentEl.createDiv({ cls: "langdock-sync-dialog-actions" }))
      .setCta().onClick(this.sync);
    this.render({ state: "checking" }, false);
  }

  render({ state, issue, uploadedAt }: NoteStatus, syncing: boolean): void {
    if (!this.statusEl || !this.uploadTimeEl || !this.issueEl || !this.action) return;
    const { translate: t, config } = this.plugin;
    this.setTitle(t("noteSync.title"));
    this.statusEl.dataset.state = state;
    this.statusEl.setText(t(syncing ? "status.syncing" : `noteSync.${state}`));
    this.uploadTimeEl.hidden = uploadedAt === undefined;
    if (uploadedAt === undefined) {
      this.uploadTimeEl.removeAttribute("datetime");
      this.uploadTimeEl.empty();
    } else {
      this.uploadTimeEl.dateTime = new Date(uploadedAt).toISOString();
      this.uploadTimeEl.setText(t("noteSync.uploadedAt", { time: this.plugin.formatSyncTime(uploadedAt) }));
    }
    const detail = this.actionIssue ?? issue;
    this.issueEl.setText(detail ? formatIssue(t, detail) : "");
    this.issueEl.hidden = !detail || syncing;
    this.action.setButtonText(t("commands.syncNow")).setDisabled(syncing || state === "checking" || state === "ineligible"
      || !isId(config.folderId) || !this.plugin.hasApiKey());
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

interface NoteButton {
  path: string;
  button: HTMLElement;
  observer: MutationObserver;
}

export class NoteSyncControls {
  private readonly buttons = new Map<EditableFileView, NoteButton>();
  private readonly syncing = new Set<string>();
  private remote: Promise<RemoteInventory> | undefined;
  private dialog?: NoteSyncModal;
  private timer: number | undefined;
  private generation = 0;
  private disposed = false;

  constructor(private readonly plugin: LangdockSyncPlugin) {}

  refresh(recheckRemote = false): void {
    if (this.disposed) return;
    window.clearTimeout(this.timer);
    const generation = ++this.generation;
    if (recheckRemote) this.remote = undefined;
    if (!this.plugin.showNoteSyncButton) {
      this.clear();
      return;
    }
    this.timer = window.setTimeout(() => { void this.update(generation); }, 50);
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    window.clearTimeout(this.timer);
    this.clear();
  }

  private clear(): void {
    for (const view of this.buttons.keys()) this.removeButton(view);
    this.remote = undefined;
    this.dialog?.close();
  }

  private async update(generation: number): Promise<void> {
    const settings = this.plugin.config;
    const views = new Map<EditableFileView, string>();
    this.plugin.app.workspace.iterateAllLeaves(({ view }) => {
      if (view instanceof EditableFileView && view.file) views.set(view, view.file.path);
    });
    const dialog = this.dialog;
    const paths = new Set(views.values());
    if (dialog) paths.add(dialog.path);
    const files = new Map<string, SyncFile>();
    for (const path of paths) {
      const file = await this.plugin.readEligibleFile(path, settings).catch(() => null);
      if (this.generation !== generation) return;
      if (file) files.set(path, file);
    }

    for (const [view, control] of this.buttons) {
      if (views.get(view) === control.path && files.get(control.path) && view.containerEl.contains(control.button)) continue;
      this.removeButton(view);
    }
    const needsRemote = !this.remote;
    for (const [view, path] of views) {
      if (!files.get(path) || view.file?.path !== path) continue;
      const control = this.buttons.get(view) ?? this.addButton(view, path);
      if (needsRemote || !control.button.dataset.state) this.renderButton(control.button, "checking");
    }

    if (dialog === this.dialog && dialog && !files.get(dialog.path)) dialog.render({ state: "ineligible" }, this.syncing.has(dialog.path));
    if (!files.size) return;
    this.remote ??= this.plugin.readManagedFiles(settings).then((files) => ({ files }), (error: unknown) => ({ issue: issueFromError(error) }));
    const remote = await this.remote;
    if (this.generation !== generation) return;

    for (const { path, button } of this.buttons.values()) {
      const file = files.get(path);
      if (file) this.renderButton(button, noteStatus(file, remote).state);
    }
    if (dialog === this.dialog && dialog) {
      const file = files.get(dialog.path);
      if (file) dialog.render(noteStatus(file, remote), this.syncing.has(dialog.path));
    }
  }

  private addButton(view: EditableFileView, path: string): NoteButton {
    const button = view.addAction("refresh-cw", this.plugin.translate("noteSync.title"), () => {
      if (view.file?.path === path) this.open(path);
    });
    button.addClass("langdock-sync-note-action", "langdock-sync-note-status");
    button.setAttribute("aria-haspopup", "dialog");

    const actions = button.parentElement;
    const placeBesideClassificator = () => {
      const classification = actions?.querySelector(":scope > .classificator-badge--header");
      if (classification && button.parentElement === actions && classification.nextElementSibling !== button) {
        classification.after(button);
      }
    };
    // Classificator can add its action after this one when enabled in an open note.
    const observer = new MutationObserver(placeBesideClassificator);
    if (actions) observer.observe(actions, { childList: true });
    placeBesideClassificator();

    const control = { path, button, observer };
    this.buttons.set(view, control);
    return control;
  }

  private removeButton(view: EditableFileView): void {
    const control = this.buttons.get(view);
    if (!control) return;
    control.observer.disconnect();
    control.button.remove();
    this.buttons.delete(view);
  }

  private renderButton(button: HTMLElement, state: NoteState): void {
    const label = this.plugin.translate(`noteSync.${state}`);
    const description = this.plugin.translate("notice.prefix", { message: label });
    button.dataset.state = state;
    if (button.textContent !== label) button.setText(label);
    if (button.getAttribute("aria-label") !== description) {
      button.setAttribute("aria-label", description);
      setTooltip(button, description);
    }
  }

  private open(path: string): void {
    this.dialog?.close();
    const dialog = new NoteSyncModal(this.plugin, path, () => { void this.sync(dialog); });
    this.dialog = dialog;
    dialog.setCloseCallback(() => {
      if (this.dialog === dialog) delete this.dialog;
    }).open();
    this.refresh(true);
  }

  private async sync(dialog: NoteSyncModal): Promise<void> {
    const { path } = dialog;
    if (this.syncing.has(path)) return;
    this.syncing.add(path);
    delete dialog.actionIssue;
    dialog.render({ state: "checking" }, true);
    try {
      const issue = await this.plugin.syncFile(path);
      if (issue) dialog.actionIssue = issue;
    } catch (error) {
      dialog.actionIssue = issueFromError(error);
    } finally {
      this.syncing.delete(path);
      this.refresh(true);
    }
  }
}
