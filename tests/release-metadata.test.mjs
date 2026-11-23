import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareRelease, validateMetadata } from "../scripts/release-metadata.mjs";

function fixture() {
  return {
    manifest: {
      id: "langdock-sync",
      name: "Langdock Sync",
      version: "0.2.0",
      minAppVersion: "1.7.4",
      description: "Sync Obsidian notes with Langdock.",
      author: "Nico Blum",
      isDesktopOnly: false,
    },
    packageMetadata: { version: "0.2.0" },
    lock: { version: "0.2.0", packages: { "": { version: "0.2.0" } } },
    versions: { "0.2.0": "1.7.4" },
  };
}

const notes = "# Changelog\n\n## [Unreleased]\n\n- A change.\n\n## [0.2.0]\n\n- Previous change.\n";

test("rejects mismatched version metadata, compatibility data and release tags", () => {
  const metadata = fixture();
  validateMetadata(metadata, "0.2.0");
  assert.throws(() => validateMetadata(metadata, "v0.2.0"), /Tag .* must match/);
  assert.throws(() => validateMetadata({ ...metadata, versions: {} }), /versions\.json must map/);
  metadata.lock.packages[""].version = "0.1.0";
  assert.throws(() => validateMetadata(metadata), /plugin version must match/);
});

test("prepares new metadata and moves the release notes while preserving previous versions", () => {
  const metadata = fixture();
  const release = prepareRelease(metadata, notes, "0.3.0", "2026-11-23");
  validateMetadata(release.metadata, "0.3.0");
  assert.deepEqual(release.metadata.versions, { "0.2.0": "1.7.4", "0.3.0": "1.7.4" });
  assert.equal(release.changelog, notes.replace("## [Unreleased]", "## [Unreleased]\n\n## [0.3.0] - 2026-11-23"));
  assert.deepEqual(metadata, fixture());
});

test("preserves a changelog checked out with CRLF line endings", () => {
  const changelog = notes.replaceAll("\n", "\r\n");
  const release = prepareRelease(fixture(), changelog, "0.3.0", "2026-11-23");
  assert.equal(release.changelog, changelog.replace("## [Unreleased]", "## [Unreleased]\r\n\r\n## [0.3.0] - 2026-11-23"));
});

test("rejects old versions, invalid versions and releases with empty notes", () => {
  const metadata = fixture();
  assert.throws(() => prepareRelease(metadata, notes, "0.1.12", "2026-11-23"), /must be newer/);
  assert.throws(() => prepareRelease(metadata, notes, "0.03.0", "2026-11-23"), /x\.y\.z/);
  assert.throws(() => prepareRelease(metadata, notes.replace("- A change.", ""), "0.3.0", "2026-11-23"), /needs release notes/);
});
