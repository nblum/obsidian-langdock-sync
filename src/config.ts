import { isLanguagePreference, isStoredIssue } from "./i18n.ts";
import type { Issue, LanguagePreference } from "./i18n.ts";
import { supportedAttachmentExtensions } from "./file-formats.ts";

export interface PropertyFilter {
  property: string;
  value: string;
}

export interface FolderMapping {
  path: string;
  folderId: string;
}

export const syncIntervals = [0, 15, 30, 60, 120] as const;

export interface Settings {
  folderMappings: FolderMapping[];
  automatic: boolean;
  syncIntervalMinutes: typeof syncIntervals[number];
  propertyFilters: PropertyFilter[];
  attachmentExtensions: string;
}

export interface SyncStatus {
  lastSuccess: string | null;
  issues: (Issue | string)[];
}

export const apiKeySecretId = "langdock-api";
export const emptyStatus: SyncStatus = { lastSuccess: null, issues: [] };

export function isVisiblePath(path: string): boolean {
  return path.split("/").every((part) => part.length > 0 && !part.startsWith("."));
}

export function isLangdockId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[^a-zA-Z0-9_-]/u.test(value);
}

export function findFolderMapping(path: string, mappings: readonly FolderMapping[]): FolderMapping | undefined {
  let best: FolderMapping | undefined;
  for (const mapping of mappings) {
    if (mapping.path === "/" || path.startsWith(`${mapping.path}/`)) {
      if (!best || best.path === "/" || mapping.path.length > best.path.length) {
        best = mapping;
      }
    }
  }
  return best;
}

function readFolderMappings(values: Record<string, unknown>): FolderMapping[] {
  const mappings = new Map<string, FolderMapping>();
  const legacyId = isLangdockId(values.folderId) ? values.folderId : "";
  const entries: unknown[] = Array.isArray(values.folderMappings) ? values.folderMappings
    : Array.isArray(values.folders) ? values.folders.map((path: unknown) => ({ path, folderId: legacyId })) : [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const { path, folderId } = entry as Record<string, unknown>;
    if (typeof path !== "string" || (path !== "/" && !isVisiblePath(path)) || mappings.has(path)) continue;
    mappings.set(path, { path, folderId: isLangdockId(folderId) ? folderId : "" });
  }
  return [...mappings.values()];
}

function parseAttachmentExtensions(value: string): string {
  const entries = value.split(",").map((entry) => entry.trim().toLowerCase().replace(/^\./u, ""));
  const supported = entries.filter((entry) => supportedAttachmentExtensions.includes(entry));
  return [...new Set(supported)].join(",");
}

function isPropertyFilter(value: unknown): value is PropertyFilter {
  if (typeof value !== "object" || value === null) return false;
  const { property, value: expected } = value as Record<string, unknown>;
  return typeof property === "string" && !!property.trim() && typeof expected === "string" && !!expected.trim();
}

export function readData(data: unknown): {
  settings: Settings;
  status: SyncStatus;
  targetNames: Map<string, string>;
  legacySecretId: string | null;
  language: LanguagePreference;
  introductionSeen: boolean;
  showNoteSyncButton: boolean;
} {
  const values = typeof data === "object" && data !== null ? data as Record<string, unknown> : {};
  const folderMappings = readFolderMappings(values);
  const assignedIds = new Set(folderMappings.map(({ folderId }) => folderId).filter(Boolean));
  const targetNames = new Map<string, string>();
  if (typeof values.targetNames === "object" && values.targetNames !== null) {
    for (const [id, name] of Object.entries(values.targetNames)) {
      if (assignedIds.has(id) && typeof name === "string" && name.trim()) targetNames.set(id, name);
    }
  }
  const propertyFilters = Array.isArray(values.propertyFilters) && (values.propertyFilters as unknown[]).every(isPropertyFilter)
    ? values.propertyFilters as PropertyFilter[]
    : [{ property: "classification", value: "public" }];
  return {
    settings: {
      folderMappings,
      automatic: values.automatic === true && folderMappings.length > 0 && folderMappings.every(({ folderId }) => !!folderId),
      syncIntervalMinutes: syncIntervals.find((minutes) => minutes === values.syncIntervalMinutes) ?? 0,
      propertyFilters,
      attachmentExtensions: typeof values.attachmentExtensions === "string"
        ? parseAttachmentExtensions(values.attachmentExtensions) : "",
    },
    targetNames,
    legacySecretId: typeof values.secretId === "string" ? values.secretId : null,
    language: isLanguagePreference(values.language) ? values.language : "auto",
    introductionSeen: values.introductionSeen === true,
    showNoteSyncButton: values.showNoteSyncButton !== false,
    status: {
      lastSuccess: typeof values.lastSuccess === "string" && Number.isFinite(Date.parse(values.lastSuccess))
        ? values.lastSuccess : null,
      issues: Array.isArray(values.issues) ? (values.issues as unknown[]).filter(isStoredIssue)
        : typeof values.error === "string" ? [values.error] : [],
    },
  };
}
