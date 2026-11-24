import type { Settings } from "./config.ts";
import { LocalizedError } from "./i18n.ts";
import type { Issue } from "./i18n.ts";
import { isFailed, SyncError } from "./langdock.ts";
import type { IndexStatus, Langdock, ManagedFile } from "./langdock.ts";
import { readSyncFile } from "./notes.ts";
import type { FileStorage, SyncFile } from "./notes.ts";

interface Transfer {
  file: SyncFile;
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

export function planSync(local: ReadonlyMap<string, SyncFile>, files: readonly ManagedFile[]): Plan {
  const versions = new Map<string, ManagedFile[]>();
  const removals: Removal[] = [];
  const transfers: Transfer[] = [];

  for (const file of files) {
    if (!local.has(file.pathHash)) {
      removals.push({ file });
      continue;
    }
    const entries = versions.get(file.pathHash) ?? [];
    entries.push(file);
    versions.set(file.pathHash, entries);
  }

  for (const file of local.values()) {
    const entries = versions.get(file.pathHash) ?? [];
    const matching = entries.filter(({ contentHash }) => contentHash === file.contentHash);
    const synced = matching.find(({ status }) => status === "SYNCED");
    if (synced) {
      for (const older of entries) {
        if (older.id !== synced.id) removals.push({ file: older, path: file.path });
      }
      continue;
    }
    const pending = matching.find(({ status }) => !isFailed(status));
    const failed = matching.find(({ status }) => isFailed(status));
    transfers.push({ file, versions: entries, ...(pending && { pending }), ...(failed && { failed }) });
  }

  return { transfers, removals };
}

export function planSingleFile(file: SyncFile, files: readonly ManagedFile[]): Plan & { versions: ManagedFile[] } {
  const versions = files.filter(({ pathHash }) => pathHash === file.pathHash);
  return { ...planSync(new Map([[file.pathHash, file]]), versions), versions };
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
    await new Promise<void>((resolve) => window.setTimeout(resolve, 3_000));
  }
}

export async function applyPlan(
  plan: Plan,
  storage: FileStorage,
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

  for (const { file, versions, pending, failed } of plan.transfers) {
    assertCurrent();
    try {
      let id = pending?.id;
      const name = pending?.name ?? file.uploadName;
      if (!id) {
        if (failed && !retryFailed) checkIndexStatus(failed.status);
        const current = await readSyncFile(storage, file.path, propertyFilters);
        if (!current || current.file.contentHash !== file.contentHash) throw new StaleRun();
        assertCurrent();
        id = await client.upload(folderId, name, current.bytes, assertCurrent);
      }

      await waitForIndex(client, folderId, id, name, assertCurrent);
      for (const older of versions) {
        if (older.id === id) continue;
        assertCurrent();
        await client.delete(folderId, older.id);
      }
    } catch (error) {
      if (!(error instanceof IndexIssue || (error instanceof SyncError && !error.retry))) throw error;
      report.issues.push({ ...error.issue, path: file.path });
      report.retry ||= error.retry;
    }
  }
  assertCurrent();
  return report;
}
