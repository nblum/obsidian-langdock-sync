import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";
import { updateScreenshots } from "../scripts/update-screenshots.mjs";
import assets from "./e2e/screenshot-assets.json" with { type: "json" };

test("publishes a complete screenshot set and preserves prior assets when a capture is invalid", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "langdock-screenshots-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const captures = join(directory, "captures");
  const destination = join(directory, "assets");
  await mkdir(captures);
  await mkdir(destination);
  await writeFile(join(destination, "keep.txt"), "Existing asset");
  const preview = "preview.webp";
  const previous = Buffer.from("Prior version");
  await writeFile(join(destination, preview), previous);

  const manifest = { obsidianVersion: "1.15.1", assets };
  await writeFile(join(captures, "manifest.json"), JSON.stringify({ ...manifest, complete: false }));
  await assert.rejects(updateScreenshots(captures, destination), /Run npm run screenshots/);
  assert.deepEqual(await readFile(join(destination, preview)), previous);
  await writeFile(join(captures, "manifest.json"), JSON.stringify({ ...manifest, complete: true }));
  await assert.rejects(updateScreenshots(captures, destination), { code: "ENOENT" });

  const valid = await sharp({ create: { width: 320, height: 160, channels: 3, background: "#123456" } }).webp().toBuffer();
  for (const { filename } of assets) await writeFile(join(captures, filename), valid);
  await writeFile(join(captures, preview), "Corrupt image");
  await assert.rejects(updateScreenshots(captures, destination));
  assert.deepEqual(await readFile(join(destination, preview)), previous);

  await writeFile(join(captures, preview), valid);
  await updateScreenshots(captures, destination);
  for (const { filename } of assets) assert.deepEqual(await readFile(join(destination, filename)), valid);
  assert.equal(await readFile(join(destination, "keep.txt"), "utf8"), "Existing asset");
});
