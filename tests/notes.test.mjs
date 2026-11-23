import assert from "node:assert/strict";
import { test } from "node:test";
import { readData } from "../src/config.ts";
import { classification, inspectNote, IncompleteInventory, inventory, managedName } from "../src/notes.ts";
import { applyPlan, planSync, StaleRun } from "../src/sync.ts";

const bytes = (text) => new TextEncoder().encode(text).buffer;
const note = (fields) => bytes(`---\n${fields}\n---\nMarkdown\n`);
const fullVault = { folders: ["/"], propertyFilters: [] };

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
    folders: ["Share", "Share/Sub"], propertyFilters: [],
  }, () => {});
  assert.deepEqual(listed, ["Share", "Share/Sub"]);
  assert.deepEqual([...result.values()].map(({ path }) => path), ["Share/Sub/Note.md"]);
  await assert.rejects(inventory(storage, [], { folders: ["Missing"], propertyFilters: [] }, () => {}), IncompleteInventory);
  await assert.rejects(inventory(storage, [], { folders: [], propertyFilters: [] }, () => {}), IncompleteInventory);
});
