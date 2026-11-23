import { createServer } from "node:http";
import { once } from "node:events";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { bundleOptions } from "../../scripts/bundle-options.mjs";

const editorId = "writer";
const viewerId = "viewer";

async function buffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export async function prepareMockLangdock() {
  const directory = await mkdtemp(join(tmpdir(), "langdock-sync-mock-"));
  const files = new Map();
  const requests = [];
  let sequence = 0;
  const defaultNames = { writer: "Test-Wissensdatenbank", viewer: "Nur Ansicht" };
  let folderNames = defaultNames;
  let nextStatus = "SYNCED";
  let offline = false;
  let partial = false;
  const server = createServer((request, response) => {
    const send = (status, data) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(data));
    };
    const success = (result) => send(200, { status: "success", result });
    const error = (status) => send(status, { status: "error" });

    void (async () => {
      const { pathname, searchParams } = new URL(request.url, "http://localhost");
      const { method } = request;
      if (pathname === "/__test/state" && method === "GET") {
        return send(200, { files: [...files.values()], requests });
      }
      if (pathname === "/__test/control" && method === "POST") {
        const command = JSON.parse(await buffer(request));
        if (command.reset) {
          files.clear();
          requests.length = 0;
          sequence = 0;
          folderNames = defaultNames;
          nextStatus = "SYNCED";
          offline = false;
          partial = false;
        }
        for (const file of command.seed ?? []) files.set(file.id, file);
        for (const [id, status] of Object.entries(command.statuses ?? {})) files.get(id).syncStatus = status;
        folderNames = command.folderNames ?? folderNames;
        nextStatus = command.nextStatus ?? nextStatus;
        offline = command.offline ?? offline;
        partial = command.partial ?? partial;
        return send(200, { ok: true });
      }

      const entry = { method, path: pathname };
      requests.push(entry);
      if (request.headers.authorization !== "Bearer simulated-key") return error(401);
      if (offline) return error(503);
      if (pathname === "/knowledge" && method === "GET") {
        if (searchParams.has("cursor")) {
          if (searchParams.get("cursor") !== viewerId) return error(400);
          return success({ folders: [{ id: editorId, name: folderNames.writer, role: "EDITOR", fileCount: files.size }] });
        }
        return success({
          folders: [{ id: viewerId, name: folderNames.viewer, role: "USER", fileCount: 0 }],
          nextCursor: viewerId,
        });
      }
      if (pathname === "/knowledge/writer/list" && method === "GET") {
        const inventory = [...files.values()].map(({ id, name, syncStatus }) => ({ id, name, syncStatus }));
        return success(partial ? inventory.slice(0, -1) : inventory);
      }
      if (pathname === "/knowledge/writer" && method === "POST") {
        const contentType = request.headers["content-type"];
        const form = await new Response(await buffer(request), { headers: { "Content-Type": contentType } }).formData();
        const file = form.get("file");
        if (!(file instanceof File) || file.type !== "text/markdown") return error(400);
        const id = `upload-${++sequence}`;
        const { name } = file;
        entry.id = id;
        files.set(id, { id, name, syncStatus: nextStatus, bytes: Buffer.from(await file.arrayBuffer()).toString("base64") });
        nextStatus = "SYNCED";
        return success({ id, name });
      }

      const id = /^\/knowledge\/writer\/([\w-]+)$/u.exec(pathname)?.[1];
      if (!id || !files.has(id)) return error(404);
      entry.id = id;
      if (method === "GET") {
        const { name, syncStatus } = files.get(id);
        entry.syncStatus = syncStatus;
        const result = { id, name, syncStatus };
        if (syncStatus.endsWith("_FAILED")) return send(200, { status: "error", result });
        return success(result);
      }
      if (method === "DELETE") {
        files.delete(id);
        return success(null);
      }
      return error(405);
    })().catch((failure) => {
      console.error("Mock Langdock:", failure.message);
      error(500);
    });
  });

  try {
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    const url = `http://127.0.0.1:${server.address().port}`;
    await Promise.all([
      cp("manifest.json", join(directory, "manifest.json")),
      cp("styles.css", join(directory, "styles.css")),
      build({ ...bundleOptions, outfile: join(directory, "main.js"), minify: true,
        define: { LANGDOCK_TEST_API_URL: JSON.stringify(`${url}/knowledge`) } }),
    ]);
    return {
      env: { LANGDOCK_E2E_URL: url, LANGDOCK_E2E_PLUGIN: directory },
      async close() {
        await new Promise((resolve) => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
