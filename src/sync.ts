import type { Settings } from "./config.ts";
import { LocalizedError } from "./i18n.ts";
import type { Issue } from "./i18n.ts";
import { isFailed, SyncError } from "./langdock.ts";
import type { IndexStatus, Langdock, ManagedFile } from "./langdock.ts";
import { inspectNote, readNote } from "./notes.ts";
import type { Note, NoteStorage } from "./notes.ts";

interface Transfer {
  note: Note;
  versions: ManagedFile[];
  pending?: ManagedFile;
  failed?: ManagedFile;
}

interface Removal {
  file: ManagedFile;
  path?: string;
}

export interface Plan {
  transfers: Transfer[];
  removals: Removal[];
}

export interface RunReport {
  issues: Issue[];
  retry: boolean;
}

export function planSync(notes: ReadonlyMap<string, Note>, files: readonly ManagedFile[]): Plan {
  const versions = new Map<string, ManagedFile[]>();
  const removals: Removal[] = [];
  const transfers: Transfer[] = [];

  for (const file of files) {
    if (!notes.has(file.pathHash)) {
      removals.push({ file });
      continue;
    }
    const entries = versions.get(file.pathHash) ?? [];
    entries.push(file);
    versions.set(file.pathHash, entries);
  }

  for (const note of notes.values()) {
    const entries = versions.get(note.pathHash) ?? [];
    const matching = entries.filter(({ contentHash }) => contentHash === note.contentHash);
    const synced = matching.find(({ status }) => status === "SYNCED");
    if (synced) {
      for (const file of entries) {
        if (file.id !== synced.id) removals.push({ file, path: note.path });
      }
      continue;
    }
    const pending = matching.find(({ status }) => !isFailed(status));
    const failed = matching.find(({ status }) => isFailed(status));
    transfers.push({ note, versions: entries, ...(pending && { pending }), ...(failed && { failed }) });
  }

  return { transfers, removals };
}

export class StaleRun extends LocalizedError {
  constructor() {
    super("errors.staleRun");
  }
}

class IndexIssue extends SyncError {}

function checkIndexStatus(status: IndexStatus): boolean {
  if (isFailed(status)) throw new IndexIssue("errors.indexFailed", false, { status });
  return status === "SYNCED";
}

async function waitForIndex(
  client: Langdock,
  folderId: string,
  id: string,
  name: string,
  assertCurrent: () => void,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (true) {
    assertCurrent();
    const status = await client.status(folderId, id, name);
    assertCurrent();
    if (checkIndexStatus(status)) return;
    if (Date.now() >= deadline) {
      throw new IndexIssue("errors.indexPending", true);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

export async function applyPlan(
  plan: Plan,
  storage: NoteStorage,
  client: Langdock,
  settings: Pick<Settings, "folderId" | "propertyFilters">,
  retryFailed: boolean,
  assertCurrent: () => void,
): Promise<RunReport> {
  const { folderId, propertyFilters } = settings;
  const report: RunReport = { issues: [], retry: false };

  for (const { file } of plan.removals) {
    assertCurrent();
    await client.delete(folderId, file.id);
  }

  for (const { note, versions, pending, failed } of plan.transfers) {
    assertCurrent();
    try {
      let id = pending?.id;
      let name = pending?.name ?? note.uploadName;
      if (!id) {
        if (failed && !retryFailed) checkIndexStatus(failed.status);
        const bytes = await readNote(storage, note.path);
        const current = await inspectNote(note.path, bytes, propertyFilters);
        if (current?.contentHash !== note.contentHash) throw new StaleRun();
        name = note.uploadName;
        id = await client.upload(folderId, name, bytes, assertCurrent);
      }

      await waitForIndex(client, folderId, id, name, assertCurrent);
      for (const older of versions) {
        if (older.id === id) continue;
        assertCurrent();
        await client.delete(folderId, older.id);
      }
    } catch (error) {
      if (!(error instanceof IndexIssue || (error instanceof SyncError && !error.retry))) throw error;
      report.issues.push({ ...error.issue, path: note.path });
      report.retry ||= error.retry;
    }
  }
  assertCurrent();
  return report;
}
