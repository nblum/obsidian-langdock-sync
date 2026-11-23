import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import assets from "../tests/e2e/screenshot-assets.json" with { type: "json" };

export async function updateScreenshots(captures = resolve("e2e-results/screenshots"), destination = resolve("assets/screenshots")) {
  const run = JSON.parse(await readFile(join(captures, "manifest.json"), "utf8"));
  assert.equal(run.complete, true, "Run npm run screenshots successfully before updating documentation assets.");
  assert.deepEqual(run.assets, assets, "The screenshots must match the current asset manifest.");

  const images = await Promise.all(assets.map(async ({ filename }) => {
    const bytes = await readFile(join(captures, filename));
    const image = sharp(bytes, { failOn: "warning" });
    const { format, width, height } = await image.metadata();
    assert.equal(format, "webp", `${filename} must be a WebP image.`);
    assert.ok(width >= 200 && height >= 80, `${filename} is too small.`);
    await image.raw().toBuffer();
    return { filename, bytes };
  }));

  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const work = await mkdtemp(join(parent, ".screenshots-"));
  const replacement = join(work, "new");
  const previous = join(work, "previous");
  let keepBackup = false;
  try {
    await mkdir(replacement);
    try {
      await cp(destination, replacement, { recursive: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const { filename, bytes } of images) {
      // Replace a staged filename without following a symlink in the existing asset directory.
      const target = join(replacement, filename);
      await rm(target, { force: true });
      await writeFile(target, bytes, { flag: "wx" });
    }

    let hasPrevious = false;
    try {
      await rename(destination, previous);
      hasPrevious = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(replacement, destination);
    } catch (error) {
      if (hasPrevious) {
        try {
          await rename(previous, destination);
        } catch (rollbackError) {
          keepBackup = true;
          throw new AggregateError([error, rollbackError], `Could not restore screenshots. The backup is in ${previous}.`, { cause: rollbackError });
        }
      }
      throw error;
    }
  } finally {
    if (!keepBackup) await rm(work, { recursive: true, force: true });
  }

  console.log(`Updated ${images.length} documentation screenshots from Obsidian ${run.obsidianVersion}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await updateScreenshots();
