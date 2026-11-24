import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { YAMLMap } from "yaml";
import { LocalizedError } from "./i18n.ts";
import { isVisiblePath } from "./config.ts";
import type { PropertyFilter } from "./config.ts";
import { fileExtension, uploadFormat } from "./file-formats.ts";

const delimiter = /^---[ \t]*\r?$/u;
const stringTag = "tag:yaml.org,2002:str";
const marker = "--obsidian-nblum-";
const managedSuffix = /--obsidian-nblum-([a-f0-9]{32})-([a-f0-9]{32})\.[a-z0-9]+$/u;
const metadataFilename = "_meta.md";
const attachmentField = "attachment-classifications";
const utf8 = new TextEncoder();

export type Classification = "public" | "internal";

export interface SyncFile {
  path: string;
  pathHash: string;
  contentHash: string;
  uploadName: string;
}

export interface FileStorage {
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  readBinary(path: string): Promise<ArrayBuffer>;
}

export class IncompleteInventory extends LocalizedError {}

function filename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function isFolderMetadata(path: string): boolean {
  return filename(path) === metadataFilename;
}

export function isCandidate(path: string, extensions: readonly string[] = []): boolean {
  const extension = fileExtension(path);
  return extension !== "" && isVisiblePath(path) && filename(path).toLowerCase() !== metadataFilename
    && (extension === "md" || extensions.includes(extension));
}

function scalarMatches(node: unknown, expected: string): boolean {
  if (!isScalar(node)) return false;
  const value: unknown = node.value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value) === expected;
  }
  return value instanceof Date && node.source === expected;
}

function hasLiteralKeys(map: YAMLMap): boolean {
  // A computed key or YAML merge can hide an opt-out or a competing classification.
  return map.items.every(({ key }) =>
    isScalar(key) && key.source !== "<<" && key.value !== "<<" && key.tag !== "tag:yaml.org,2002:merge");
}

function frontmatter(bytes: ArrayBuffer, version: "1.1" | "1.2"): YAMLMap | null {
  try {
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split(/\r?\n/u);
    const first = lines[0];
    if (first === undefined || !delimiter.test(first)) return null;
    const end = lines.findIndex((line, index) => index > 0 && delimiter.test(line));
    if (end < 0) return null;

    const document = parseDocument(lines.slice(1, end).join("\n"), { version, strict: true });
    if (document.errors.length || document.warnings.length || !isMap(document.contents)) return null;
    return hasLiteralKeys(document.contents) ? document.contents : null;
  } catch {
    return null;
  }
}

function literalEntry(properties: YAMLMap, property: string) {
  return properties.items.find(({ key }) => isScalar(key) && key.value === property
    && (key.tag === undefined || key.tag === stringTag));
}

function literalClassification(value: unknown): Classification | null {
  if (!isScalar(value) || (value.tag !== undefined && value.tag !== stringTag)) return null;
  return value.value === "public" || value.value === "internal" ? value.value : null;
}

function allowedClassification(properties: YAMLMap, label: Classification | null, filters: readonly PropertyFilter[]): Classification | null {
  if (label === null) return null;
  const optOut = properties.items.find(({ key }) => isScalar(key) && key.value === "langdock_sync");
  if (optOut) {
    const { key, value } = optOut;
    if (!isScalar(key) || (key.tag !== undefined && key.tag !== stringTag) || !isScalar(value)) return null;
    if (value.value === false || (typeof value.value === "string" && value.value.trim().toLowerCase() === "false")) return null;
  }
  const matched = new Set<string>();
  for (const { property, value } of filters) {
    if (property === "classification") {
      if (label === value) matched.add(property);
      continue;
    }
    const node = literalEntry(properties, property)?.value;
    if (isSeq(node) ? node.items.some((item) => scalarMatches(item, value)) : scalarMatches(node, value)) matched.add(property);
  }
  return filters.every(({ property }) => matched.has(property)) ? label : null;
}

export function classification(bytes: ArrayBuffer, filters: readonly PropertyFilter[] = []): Classification | null {
  const properties = frontmatter(bytes, "1.1");
  if (!properties) return null;
  return allowedClassification(properties, literalClassification(literalEntry(properties, "classification")?.value), filters);
}

function attachmentClassification(path: string, properties: YAMLMap | null, filters: readonly PropertyFilter[]): Classification | null {
  if (!properties) return null;
  const entries = literalEntry(properties, attachmentField)?.value;
  if (!isMap(entries) || (entries.tag !== undefined && entries.tag !== "tag:yaml.org,2002:map")
    || !hasLiteralKeys(entries)) return null;
  const label = literalClassification(literalEntry(entries, filename(path))?.value);
  return allowedClassification(properties, label, filters);
}

async function digest(bytes: BufferSource): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function managedName(name: string): { pathHash: string; contentHash: string } | null {
  const match = managedSuffix.exec(name);
  if (!match || match.index + match[0].length !== name.length || !uploadFormat(name)) return null;
  const [, pathHash, contentHash] = match;
  return pathHash && contentHash ? { pathHash, contentHash } : null;
}

function uploadName(path: string, pathHash: string, contentHash: string): string {
  const extension = fileExtension(path);
  const basename = filename(path).slice(0, -(extension.length + 1));
  const sanitized = Array.from(basename, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || character === '"' || character === "\\" ? "_" : character;
  }).join("");
  // Streaming decode drops an incomplete final code point, matching the Python filename limit.
  const title = new TextDecoder("utf-8", { ignoreBOM: true })
    .decode(utf8.encode(sanitized).subarray(0, 140), { stream: true });
  return `${title}${marker}${pathHash}-${contentHash}.${extension}`;
}

async function describeFile(path: string, bytes: ArrayBuffer): Promise<SyncFile> {
  const [pathHash, contentHash] = await Promise.all([digest(utf8.encode(path)), digest(bytes)]);
  return { path, pathHash, contentHash, uploadName: uploadName(path, pathHash, contentHash) };
}

export async function inspectNote(
  path: string,
  bytes: ArrayBuffer,
  filters: readonly PropertyFilter[] = [],
): Promise<SyncFile | null> {
  if (!isCandidate(path) || classification(bytes, filters) === null) return null;
  return describeFile(path, bytes);
}

async function readBytes(storage: FileStorage, path: string): Promise<ArrayBuffer> {
  try {
    return await storage.readBinary(path);
  } catch {
    throw new IncompleteInventory("errors.readFile", { path });
  }
}

async function listFolder(storage: FileStorage, directory: string): ReturnType<FileStorage["list"]> {
  try {
    return await storage.list(directory);
  } catch {
    throw new IncompleteInventory("errors.listFolder", { path: directory || "/" });
  }
}

async function readAttachmentMetadata(storage: FileStorage, directory: string, files?: readonly string[]): Promise<YAMLMap | null> {
  const metadataPath = directory ? `${directory}/${metadataFilename}` : metadataFilename;
  const entries = files ?? (await listFolder(storage, directory)).files;
  return entries.includes(metadataPath) ? frontmatter(await readBytes(storage, metadataPath), "1.2") : null;
}

export async function readSyncFile(
  storage: FileStorage,
  path: string,
  filters: readonly PropertyFilter[],
  metadata?: YAMLMap | null,
): Promise<{ file: SyncFile; bytes: ArrayBuffer } | null> {
  const markdown = fileExtension(path) === "md";
  if (!markdown) {
    const directory = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    const properties = metadata === undefined ? await readAttachmentMetadata(storage, directory) : metadata;
    if (attachmentClassification(path, properties, filters) === null) return null;
  }
  const bytes = await readBytes(storage, path);
  const file = markdown ? await inspectNote(path, bytes, filters) : await describeFile(path, bytes);
  return file ? { file, bytes } : null;
}

export async function inventory(
  storage: FileStorage,
  indexedPaths: readonly string[],
  scope: { folders: readonly string[]; propertyFilters: readonly PropertyFilter[]; attachmentExtensions: string },
  assertCurrent: () => void,
): Promise<Map<string, SyncFile>> {
  const roots = scope.folders.includes("/") ? [""] : scope.folders.filter((folder) =>
    !scope.folders.some((other) => folder.startsWith(`${other}/`)));
  if (!roots.length) throw new IncompleteInventory("errors.folderRequired");
  const pending = [...new Set(roots)];
  const extensions = scope.attachmentExtensions.split(",");
  const candidate = (path: string) => isCandidate(path, extensions);
  const indexed = new Set(indexedPaths);
  const paths = new Map<string, YAMLMap | null>();
  while (pending.length) {
    const directory = pending.pop() ?? "";
    assertCurrent();
    const entries = await listFolder(storage, directory);
    const prefix = directory ? `${directory}/` : "";
    const children = new Set<string>();
    for (const path of [...entries.files, ...entries.folders]) {
      const basename = path.slice(prefix.length);
      if (!path.startsWith(prefix) || !basename || basename === "." || basename === ".." || basename.includes("/") || children.has(path)) {
        throw new IncompleteInventory("errors.directoryChanged");
      }
      children.add(path);
    }
    const candidates = entries.files.filter(candidate);
    let metadata = null;
    if (candidates.some((path) => fileExtension(path) !== "md")) {
      const metadataPath = prefix + metadataFilename;
      if (indexed.has(metadataPath) && !entries.files.includes(metadataPath)) {
        throw new IncompleteInventory("errors.vaultMismatch");
      }
      metadata = await readAttachmentMetadata(storage, directory, entries.files);
    }
    for (const path of candidates) paths.set(path, metadata);
    pending.push(...entries.folders.filter(isVisiblePath));
  }

  if (indexedPaths.some((path) => candidate(path) && !paths.has(path)
    && roots.some((root) => !root || path.startsWith(`${root}/`)))) {
    throw new IncompleteInventory("errors.vaultMismatch");
  }

  const files = new Map<string, SyncFile>();
  for (const path of [...paths.keys()].sort()) {
    assertCurrent();
    const result = await readSyncFile(storage, path, scope.propertyFilters, paths.get(path) ?? null);
    if (result) {
      const { file } = result;
      if (files.has(file.pathHash)) {
        throw new IncompleteInventory("errors.hashCollision");
      }
      files.set(file.pathHash, file);
    }
  }
  assertCurrent();
  return files;
}
