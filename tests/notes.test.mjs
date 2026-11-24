import assert from "node:assert/strict";
import { test } from "node:test";
import { readData } from "../src/config.ts";
import { classification, inspectNote, IncompleteInventory, inventory, managedName } from "../src/notes.ts";
import { applyPlan, planSync, StaleRun } from "../src/sync.ts";

const bytes = (text) => new TextEncoder().encode(text).buffer;
const note = (fields) => bytes(`---\n${fields}\n---\nMarkdown\n`);
const fullVault = { folders: ["/"], propertyFilters: [], attachmentExtensions: "" };

test("accepts literal Obsidian classifications and rejects ambiguous or opted-out frontmatter", () => {
  assert.equal(classification(note("classification: public")), "public");
  assert.equal(classification(note('classification: "internal"\nlangdock_sync: true')), "internal");

  const excluded = [
    "classification: PUBLIC",
    "classification: confidential",
    "classification: public\nclassification: internal",
    "classification: public\n!!str classification: internal",
    "classification: [public]",
    "classification: {type: public}",
    "classification: !other public",
    "source: &label public\nclassification: *label",
    "other: &defaults {langdock_sync: false}\n<<: *defaults\nclassification: public",
    "classification: public\nlangdock_sync: false",
    'classification: public\nlangdock_sync: " FaLsE "',
    "classification: public\nlangdock_sync: off",
    "classification: public\nlangdock_sync: true\nlangdock_sync: false",
    "classification: public\nother: [unterminated",
  ];
  for (const fields of excluded) assert.equal(classification(note(fields)), null, fields);
  assert.equal(classification(bytes("Body\n---\nclassification: public\n---")), null);
  assert.equal(classification(bytes("---\nclassification: public")), null);
  assert.equal(classification(new Uint8Array([0xff, 0xfe]).buffer), null);
});

test("matches the Python path and byte hashes for UTF-8 BOM, CRLF and non-ASCII paths", async () => {
  const content = bytes("\uFEFF---\r\nclassification: public\r\n---\r\nGrüße\r\n");
  const inspected = await inspectNote("Ordner/Öffentlich.md", content);
  assert.deepEqual(inspected, {
    path: "Ordner/Öffentlich.md",
    pathHash: "c10da1025d2b19965c8e26feb819f716",
    contentHash: "6686ac8ba4176c7f12dcdb61746b4a62",
    uploadName: "Öffentlich--obsidian-nblum-c10da1025d2b19965c8e26feb819f716-6686ac8ba4176c7f12dcdb61746b4a62.md",
  });
  assert.deepEqual(managedName(inspected.uploadName), {
    pathHash: inspected.pathHash,
    contentHash: inspected.contentHash,
  });
  assert.equal(managedName(`${inspected.uploadName}\n`), null);
  assert.equal(managedName("Manual.md"), null);
  const title = "a".repeat(139);
  const long = await inspectNote(`${title}ä.md`, content);
  assert.ok(long.uploadName.startsWith(`${title}--obsidian-nblum-`));
});

test("rejects an incomplete local inventory before planning any writes", async () => {
  const storage = {
    list: async () => ({ files: ["Read.md"], folders: [] }),
    readBinary: async () => { throw new Error("EIO"); },
  };
  await assert.rejects(inventory(storage, ["Missing.md"], fullVault, () => {}), IncompleteInventory);
  await assert.rejects(inventory(storage, [], fullVault, () => {}), /Read\.md/);
});

test("rechecks the exact upload bytes if the note changed after building the plan", async () => {
  const local = await inspectNote("Note.md", note("classification: public"));
  const plan = planSync(new Map([[local.pathHash, local]]), []);
  let uploads = 0;
  const storage = { readBinary: async () => note("classification: confidential") };
  const client = { upload: async () => { uploads++; } };
  await assert.rejects(applyPlan(plan, storage, client, { folderId: "writer", propertyFilters: [] }, false, () => {}), StaleRun);
  assert.equal(uploads, 0);
});

test("defaults to public and requires a local folder before enabling automatic sync", () => {
  const defaults = readData({ folderId: "writer", automatic: true }).settings;
  assert.deepEqual(defaults.folders, []);
  assert.equal(defaults.automatic, false);
  assert.equal(defaults.attachmentExtensions, "");
  assert.deepEqual(defaults.propertyFilters, [{ property: "classification", value: "public" }]);
  assert.deepEqual(readData({ folders: ["/"], propertyFilters: [] }).settings.propertyFilters, []);
});

test("property filters allow alternatives within a property and require all selected properties", () => {
  const filters = [
    { property: "classification", value: "public" },
    { property: "classification", value: "internal" },
    { property: "audience", value: "team" },
  ];
  assert.equal(classification(note("classification: internal\naudience: [ops, team]"), filters), "internal");
  assert.equal(classification(note("classification: public\naudience: public"), filters), null);
  assert.equal(classification(note("classification: confidential\naudience: team"), filters), null);
  assert.equal(classification(note("classification: public\naudience: team\nlangdock_sync: false"), filters), null);
});

test("inventories only selected folder trees, including subfolders and excluding similar prefixes", async () => {
  const listed = [];
  const storage = {
    list: async (path) => {
      listed.push(path);
      if (path === "Share") return { files: [], folders: ["Share/Sub"] };
      if (path === "Share/Sub") return { files: ["Share/Sub/Note.md"], folders: [] };
      throw new Error("Path missing");
    },
    readBinary: async (path) => {
      assert.equal(path, "Share/Sub/Note.md");
      return note("classification: public");
    },
  };
  const result = await inventory(storage, ["Share/Sub/Note.md", "Shared/Other.md"], {
    ...fullVault, folders: ["Share", "Share/Sub"],
  }, () => {});
  assert.deepEqual(listed, ["Share", "Share/Sub"]);
  assert.deepEqual([...result.values()].map(({ path }) => path), ["Share/Sub/Note.md"]);
  await assert.rejects(inventory(storage, [], { ...fullVault, folders: ["Missing"] }, () => {}), IncompleteInventory);
  await assert.rejects(inventory(storage, [], { ...fullVault, folders: [] }, () => {}), IncompleteInventory);
});

test("loads saved attachment extensions and omits formats rejected by the knowledge base", () => {
  const { settings } = readData({ attachmentExtensions: " PDF, .DOCX, pdf, , PNG,svg, jpg " });
  assert.equal(settings.attachmentExtensions, "pdf,docx");
});

test("requires an exact attachment entry in its own folder and applies other filters to the folder metadata", async () => {
  const metadataPath = "Docs/_meta.md";
  const path = "Docs/Guide.PDF";
  const entries = [path, "Docs/Case.pdf", "Docs/Private.pdf", "Docs/Unlisted.pdf", "Docs/Image.png", metadataPath];
  const read = [];
  const storage = {
    list: async (directory) => directory === "Docs"
      ? { files: entries, folders: ["Docs/Sub"] }
      : { files: ["Docs/Sub/Guide.PDF"], folders: [] },
    readBinary: async (path) => {
      read.push(path);
      return path === metadataPath
        ? note("classification: internal\naudience: [ops, team]\nattachment-classifications:\n  Guide.PDF: public\n  case.pdf: public\n  Private.pdf: confidential\n  Image.png: public")
        : new Uint8Array([0xff, 0x00, 0x13]).buffer;
    },
  };
  const scope = {
    folders: ["Docs"], attachmentExtensions: "pdf",
    propertyFilters: [{ property: "classification", value: "public" }, { property: "audience", value: "team" }],
  };
  const files = await inventory(storage, entries, scope, () => {});
  assert.deepEqual([...files.values()].map(({ path }) => path), [path]);
  assert.deepEqual(read, [metadataPath, path]);
  const file = [...files.values()][0];
  assert.match(file.uploadName, /^Guide--obsidian-nblum-.*\.pdf$/u);
  assert.deepEqual(managedName(file.uploadName), { pathHash: file.pathHash, contentHash: file.contentHash });
  assert.equal(managedName(file.uploadName.replace(/\.pdf$/u, ".png")), null);
  assert.equal((await inventory(storage, entries, { ...scope, attachmentExtensions: "" }, () => {})).size, 0);
});

test("rechecks attachment metadata before upload and stops on unreadable metadata", async () => {
  const path = "Guide.pdf";
  const metadataPath = "_meta.md";
  let metadata = note("attachment-classifications:\n  Guide.pdf: public");
  const storage = {
    list: async () => ({ files: [path, metadataPath], folders: [] }),
    readBinary: async (path) => {
      if (path !== metadataPath) return bytes("Attachment data");
      if (!metadata) throw new Error("EIO");
      return metadata;
    },
  };
  const scope = { ...fullVault, attachmentExtensions: "pdf" };
  const files = await inventory(storage, [path, metadataPath], scope, () => {});
  assert.equal(files.size, 1);
  metadata = note("classification: public\nattachment-classifications:\n  Guide.pdf: confidential");
  let uploads = 0;
  const client = { upload: async () => { uploads++; } };
  const settings = { ...scope, folderId: "writer" };
  await assert.rejects(applyPlan(planSync(files, []), storage, client, settings, false, () => {}), StaleRun);
  assert.equal(uploads, 0);
  metadata = note("langdock_sync: false\nattachment-classifications:\n  Guide.pdf: public");
  assert.equal((await inventory(storage, [path, metadataPath], scope, () => {})).size, 0);
  metadata = null;
  await assert.rejects(inventory(storage, [path, metadataPath], scope, () => {}), /_meta\.md/u);
  const missingMetadata = { ...storage, list: async () => ({ files: [path], folders: [] }) };
  await assert.rejects(inventory(missingMetadata, [path, metadataPath], scope, () => {}), IncompleteInventory);
});
