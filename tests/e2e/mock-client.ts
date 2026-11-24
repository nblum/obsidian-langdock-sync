import { createHash } from "node:crypto";
import { expect } from "@wdio/globals";

interface RemoteFile {
  id: string;
  name: string;
  syncStatus: string;
  folderId?: string;
  createdAt?: string;
  bytes?: string;
}

export interface RequestEntry {
  method: string;
  path: string;
  id?: string;
  syncStatus?: string;
}

interface MockState {
  files: RemoteFile[];
  requests: RequestEntry[];
}

const mockUrl = process.env.LANGDOCK_E2E_URL;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 32);

export function legacy(id: string, path: string, content: string, syncStatus = "SYNCED"): RemoteFile {
  const title = path.slice(path.lastIndexOf("/") + 1, -3);
  return { id, name: `${title}--obsidian-nblum-${hash(path)}-${hash(content)}.md`, syncStatus };
}

export async function control(command: {
  reset?: boolean;
  seed?: RemoteFile[];
  offline?: boolean;
  partial?: boolean | string;
  holdInventory?: boolean;
  nextStatus?: string;
  statuses?: Record<string, string>;
  folderNames?: { writer: string; viewer: string };
}): Promise<void> {
  const response = await fetch(`${mockUrl}/__test/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  expect(response.ok).toBe(true);
}

export async function state(): Promise<MockState> {
  const response = await fetch(`${mockUrl}/__test/state`);
  expect(response.ok).toBe(true);
  return await response.json() as MockState;
}
