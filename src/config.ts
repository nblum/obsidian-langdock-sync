import { isLanguagePreference, isStoredIssue } from "./i18n.ts";
import type { Issue, LanguagePreference } from "./i18n.ts";

export interface PropertyFilter {
  property: string;
  value: string;
}

export const syncIntervals = [0, 15, 30, 60, 120] as const;

export interface Settings {
  folderId: string;
  automatic: boolean;
  syncIntervalMinutes: typeof syncIntervals[number];
  folders: string[];
  propertyFilters: PropertyFilter[];
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

function isPropertyFilter(value: unknown): value is PropertyFilter {
  if (typeof value !== "object" || value === null) return false;
  const { property, value: expected } = value as Record<string, unknown>;
  return typeof property === "string" && !!property.trim() && typeof expected === "string" && !!expected.trim();
}

export function readData(data: unknown): {
  settings: Settings;
  status: SyncStatus;
  legacySecretId: string | null;
  language: LanguagePreference;
  introductionSeen: boolean;
} {
  const values = typeof data === "object" && data !== null ? data as Record<string, unknown> : {};
  const folderId = typeof values.folderId === "string" ? values.folderId : "";
  const folders = Array.isArray(values.folders)
    ? [...new Set((values.folders as unknown[]).filter((path): path is string =>
      typeof path === "string" && (path === "/" || isVisiblePath(path))))]
    : [];
  const propertyFilters = Array.isArray(values.propertyFilters) && (values.propertyFilters as unknown[]).every(isPropertyFilter)
    ? values.propertyFilters as PropertyFilter[]
    : [{ property: "classification", value: "public" }];
  return {
    settings: {
      folderId,
      automatic: values.automatic === true && !!folderId && folders.length > 0,
      syncIntervalMinutes: syncIntervals.find((minutes) => minutes === values.syncIntervalMinutes) ?? 0,
      folders,
      propertyFilters,
    },
    legacySecretId: typeof values.secretId === "string" ? values.secretId : null,
    language: isLanguagePreference(values.language) ? values.language : "auto",
    introductionSeen: values.introductionSeen === true,
    status: {
      lastSuccess: typeof values.lastSuccess === "string" && Number.isFinite(Date.parse(values.lastSuccess))
        ? values.lastSuccess : null,
      issues: Array.isArray(values.issues) ? (values.issues as unknown[]).filter(isStoredIssue)
        : typeof values.error === "string" ? [values.error] : [],
    },
  };
}
