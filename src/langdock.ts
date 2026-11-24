import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { isLangdockId } from "./config.ts";
import { uploadFormat } from "./file-formats.ts";
import { LocalizedError } from "./i18n.ts";
import type { ErrorKey, Issue } from "./i18n.ts";
import { managedName } from "./notes.ts";

declare const LANGDOCK_TEST_API_URL: string | undefined;
const apiUrl = typeof LANGDOCK_TEST_API_URL === "string" ? LANGDOCK_TEST_API_URL : "https://api.langdock.com/knowledge";

const pendingStatuses = ["UPLOADING", "UPLOADED", "EXTRACTING", "EMBEDDING"] as const;
const failedStatuses = ["ACTION_FAILED", "EXTRACTION_FAILED", "EMBEDDING_FAILED", "TIMEOUT"] as const;
export type IndexStatus = "SYNCED" | typeof pendingStatuses[number] | typeof failedStatuses[number];

export interface Folder {
  id: string;
  name: string;
  role: "EDITOR" | "USER";
  fileCount: number;
}

export interface ManagedFile {
  id: string;
  name: string;
  pathHash: string;
  contentHash: string;
  status: IndexStatus;
  createdAt?: number;
}

export class SyncError extends LocalizedError {
  constructor(key: ErrorKey, readonly retry = false, variables?: Issue["variables"]) {
    super(key, variables);
  }
}

export function isFailed(status: unknown): status is typeof failedStatuses[number] {
  return failedStatuses.some((value) => value === status);
}

function isStatus(status: unknown): status is IndexStatus {
  return status === "SYNCED" || pendingStatuses.some((value) => value === status) || isFailed(status);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function invalidResponse(): SyncError {
  return new SyncError("errors.invalidResponse", true);
}

export class Langdock {
  constructor(
    private readonly key: string,
    private readonly transport: (request: RequestUrlParam) => Promise<RequestUrlResponse>,
  ) {}

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    options?: Pick<RequestUrlParam, "body" | "contentType">,
    attachmentDetail = false,
  ): Promise<unknown> {
    let response: RequestUrlResponse;
    try {
      response = await this.transport({
        url: apiUrl + path,
        method,
        headers: { Authorization: `Bearer ${this.key}` },
        throw: false,
        ...options,
      });
    } catch {
      throw new SyncError("errors.unreachable", true, { method });
    }

    if (method === "DELETE" && (response.status === 404 || response.status === 204)) return null;
    if (response.status < 200 || response.status >= 300) {
      const status = response.status;
      const retry = status === 408 || status === 429 || status >= 500;
      throw new SyncError("errors.http", retry, { method, status });
    }

    let payload: Record<string, unknown> | null;
    try {
      payload = record(response.json as unknown);
    } catch {
      throw invalidResponse();
    }
    if (payload?.status === "success") return payload.result;
    if (attachmentDetail && payload?.status === "error" && isFailed(record(payload.result)?.syncStatus)) {
      return payload.result;
    }
    throw invalidResponse();
  }

  async folders(): Promise<Folder[]> {
    const folders = new Map<string, Folder>();
    const cursors = new Set<string>();
    let query = "?limit=100";
    while (true) {
      const result = record(await this.request("GET", query));
      if (!Array.isArray(result?.folders)) throw invalidResponse();
      for (const item of result.folders as unknown[]) {
        const folder = record(item);
        if (!folder || !isLangdockId(folder.id) || typeof folder.name !== "string"
          || (folder.role !== "EDITOR" && folder.role !== "USER")
          || typeof folder.fileCount !== "number" || !Number.isSafeInteger(folder.fileCount) || folder.fileCount < 0
          || folders.has(folder.id)) {
          throw invalidResponse();
        }
        folders.set(folder.id, { id: folder.id, name: folder.name, role: folder.role, fileCount: folder.fileCount });
      }
      const cursor = result.nextCursor;
      if (cursor === undefined || cursor === null || cursor === "") return [...folders.values()];
      if (!isLangdockId(cursor) || cursors.has(cursor)) throw invalidResponse();
      cursors.add(cursor);
      query = `?limit=100&cursor=${encodeURIComponent(cursor)}`;
    }
  }

  async managedFiles(folderId: string, folders?: readonly Folder[]): Promise<ManagedFile[]> {
    const folder = (folders ?? await this.folders()).find(({ id }) => id === folderId);
    if (folder?.role !== "EDITOR") {
      throw new SyncError("errors.editorRequired");
    }
    const result = await this.request("GET", `/${folder.id}/list`);
    if (!Array.isArray(result) || result.length !== folder.fileCount) {
      throw new SyncError("errors.remoteInventory", true);
    }

    const managed: ManagedFile[] = [];
    const ids = new Set<string>();
    for (const item of result as unknown[]) {
      const entry = record(item);
      if (!entry || !isLangdockId(entry.id) || typeof entry.name !== "string" || ids.has(entry.id)) throw invalidResponse();
      ids.add(entry.id);
      const names = managedName(entry.name);
      if (!names) continue;
      if (!isStatus(entry.syncStatus)) throw invalidResponse();
      const createdAt = typeof entry.createdAt === "string" ? Date.parse(entry.createdAt) : NaN;
      managed.push({
        ...names, id: entry.id, name: entry.name, status: entry.syncStatus,
        ...(Number.isFinite(createdAt) && { createdAt }),
      });
    }
    return managed;
  }

  async upload(folderId: string, name: string, bytes: ArrayBuffer, assertCurrent: () => void): Promise<string> {
    const format = uploadFormat(name);
    if (!format) throw new SyncError("errors.uploadPreparation");
    if (bytes.byteLength > format.limitMb * 1_000_000) throw new SyncError("errors.fileTooLarge");
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: format.mimeType }), name);
    const body = new Response(form);
    const contentType = body.headers.get("content-type");
    if (!contentType) throw new SyncError("errors.uploadPreparation");
    const payload = await body.arrayBuffer();
    assertCurrent();
    const result = record(await this.request("POST", `/${folderId}`, { body: payload, contentType }));
    if (!result || !isLangdockId(result.id) || result.name !== name) throw invalidResponse();
    return result.id;
  }

  async status(folderId: string, id: string, name: string): Promise<IndexStatus> {
    const entry = record(await this.request("GET", `/${folderId}/${id}`, undefined, true));
    if (!entry || entry.id !== id || entry.name !== name || !isStatus(entry.syncStatus)) throw invalidResponse();
    return entry.syncStatus;
  }

  async delete(folderId: string, id: string): Promise<void> {
    await this.request("DELETE", `/${folderId}/${id}`);
  }
}
