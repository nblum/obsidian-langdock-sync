import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { LocalizedError } from "./i18n.ts";
import { isVisiblePath } from "./config.ts";
import type { PropertyFilter, Settings } from "./config.ts";

const delimiter = /^---[ \t]*\r?$/u;
const stringTag = "tag:yaml.org,2002:str";
const marker = "--obsidian-nblum-";
const managedSuffix = /--obsidian-nblum-([a-f0-9]{32})-([a-f0-9]{32})\.md$/u;
const utf8 = new TextEncoder();

export type Classification = "public" | "internal";

export interface Note {
  path: string;
  pathHash: string;
  contentHash: string;
  uploadName: string;
}

export interface NoteStorage {
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  readBinary(path: string): Promise<ArrayBuffer>;
}

export class IncompleteInventory extends LocalizedError {}

export function isCandidate(path: string): boolean {
  return isVisiblePath(path) && path.toLowerCase().endsWith(".md") && path.split("/").at(-1)?.toLowerCase() !== "_meta.md";
}

function scalarMatches(node: unknown, expected: string): boolean {
  if (!isScalar(node)) return false;
  const value: unknown = node.value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value) === expected;
  }
  return value instanceof Date && node.source === expected;
}

export function classification(bytes: ArrayBuffer, filters: readonly PropertyFilter[] = []): Classification | null {
  try {
    const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split(/\r?\n/u);
    const first = lines[0];
    if (first === undefined || !delimiter.test(first)) return null;
    const end = lines.findIndex((line, index) => index > 0 && delimiter.test(line));
    if (end < 0) return null;

    const document = parseDocument(lines.slice(1, end).join("\n"), { version: "1.1", strict: true });
    if (document.errors.length || document.warnings.length || !isMap(document.contents)) return null;
    let label: Classification | null = null;
    const matched = new Set<string>();
    for (const { key, value } of document.contents.items) {
      // A computed key or YAML merge can hide an opt-out or a competing classification.
      if (!isScalar(key) || key.source === "<<" || key.value === "<<" || key.tag === "tag:yaml.org,2002:merge") return null;
      if (typeof key.value === "string" && (key.tag === undefined || key.tag === stringTag)) {
        const property = key.value;
        if (filters.some((filter) => filter.property === property && (isSeq(value)
          ? value.items.some((item) => scalarMatches(item, filter.value))
          : scalarMatches(value, filter.value)))) matched.add(property);
      }
      if (key.value !== "classification" && key.value !== "langdock_sync") continue;
      if ((key.tag !== undefined && key.tag !== stringTag) || !isScalar(value)) return null;
      if (key.value === "langdock_sync") {
        if (value.value === false || (typeof value.value === "string" && value.value.trim().toLowerCase() === "false")) {
          return null;
        }
      } else {
        if (value.tag !== undefined && value.tag !== stringTag) return null;
        if (value.value !== "public" && value.value !== "internal") return null;
        label = value.value;
      }
    }
    return filters.every(({ property }) => matched.has(property)) ? label : null;
  } catch {
    return null;
  }
}

async function digest(bytes: BufferSource): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function managedName(name: string): { pathHash: string; contentHash: string } | null {
  const match = managedSuffix.exec(name);
  if (!match || match.index + match[0].length !== name.length) return null;
  const [, pathHash, contentHash] = match;
  return pathHash && contentHash ? { pathHash, contentHash } : null;
}

function uploadName(path: string, pathHash: string, contentHash: string): string {
  const basename = path.slice(path.lastIndexOf("/") + 1, -3);
  const sanitized = Array.from(basename, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 || character === '"' || character === "\\" ? "_" : character;
  }).join("");
  // Streaming decode drops an incomplete final code point, matching the Python filename limit.
  const title = new TextDecoder("utf-8", { ignoreBOM: true })
    .decode(utf8.encode(sanitized).subarray(0, 140), { stream: true });
  return `${title}${marker}${pathHash}-${contentHash}.md`;
}

export async function inspectNote(
  path: string,
  bytes: ArrayBuffer,
  filters: readonly PropertyFilter[] = [],
): Promise<Note | null> {
  if (!isCandidate(path) || classification(bytes, filters) === null) return null;
  const [pathHash, contentHash] = await Promise.all([digest(utf8.encode(path)), digest(bytes)]);
  return { path, pathHash, contentHash, uploadName: uploadName(path, pathHash, contentHash) };
}

export async function readNote(storage: NoteStorage, path: string): Promise<ArrayBuffer> {
  try {
    return await storage.readBinary(path);
  } catch {
    throw new IncompleteInventory("errors.readFile", { path });
  }
}

export async function inventory(
  storage: NoteStorage,
  indexedPaths: readonly string[],
  scope: Pick<Settings, "folders" | "propertyFilters">,
  assertCurrent: () => void,
): Promise<Map<string, Note>> {
  const roots = scope.folders.includes("/") ? [""] : scope.folders.filter((folder) =>
    !scope.folders.some((other) => folder.startsWith(`${other}/`)));
  if (!roots.length) throw new IncompleteInventory("errors.folderRequired");
  const pending = [...new Set(roots)];
  const paths = new Set<string>();
  while (pending.length) {
    const directory = pending.pop() ?? "";
    assertCurrent();
    let entries: Awaited<ReturnType<NoteStorage["list"]>>;
    try {
      entries = await storage.list(directory);
    } catch {
      throw new IncompleteInventory("errors.listFolder", { path: directory || "/" });
    }
    const prefix = directory ? `${directory}/` : "";
    const children = new Set<string>();
    for (const path of [...entries.files, ...entries.folders]) {
      const basename = path.slice(prefix.length);
      if (!path.startsWith(prefix) || !basename || basename === "." || basename === ".." || basename.includes("/") || children.has(path)) {
        throw new IncompleteInventory("errors.directoryChanged");
      }
      children.add(path);
    }
    for (const path of entries.files) {
      if (isCandidate(path)) paths.add(path);
    }
    pending.push(...entries.folders.filter(isVisiblePath));
  }

  if (indexedPaths.some((path) => isCandidate(path) && !paths.has(path)
    && roots.some((root) => !root || path.startsWith(`${root}/`)))) {
    throw new IncompleteInventory("errors.vaultMismatch");
  }

  const notes = new Map<string, Note>();
  for (const path of [...paths].sort()) {
    assertCurrent();
    const note = await inspectNote(path, await readNote(storage, path), scope.propertyFilters);
    if (note) {
      if (notes.has(note.pathHash)) {
        throw new IncompleteInventory("errors.hashCollision");
      }
      notes.set(note.pathHash, note);
    }
  }
  assertCurrent();
  return notes;
}
