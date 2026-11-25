import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import sharp from "sharp";
import type { Sharp } from "sharp";
import { obsidianPage } from "wdio-obsidian-service";
import { control, legacy, state } from "./mock-client.ts";
import { closeSettings, openSettings } from "./obsidian-settings.ts";
import assets from "./screenshot-assets.json" with { type: "json" };

const output = resolve("e2e-results/screenshots");
const captured = new Set<string>();
const dimensions = { width: 1280, height: 900 };
const pluginId = "langdock-sync";

async function prepareFrame(): Promise<void> {
  await browser.execute(async () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await document.fonts.ready;
    await new Promise<void>((done) => {
      requestAnimationFrame(() => { requestAnimationFrame(() => { done(); }); });
    });
  });
}

async function encode(filename: string, image: Sharp): Promise<void> {
  assert.ok(assets.some((asset) => asset.filename === filename), `Unknown screenshot ${filename}`);
  assert.ok(!captured.has(filename), `Already captured ${filename}`);
  await image.webp({ quality: 90 }).toFile(join(output, filename));
  captured.add(filename);
}

async function captureElement(filename: string, selector: string, topHeight?: number): Promise<void> {
  const element = $(selector);
  await expect(element).toBeDisplayed();
  await prepareFrame();
  await element.waitForStable();
  const png = Buffer.from(await browser.takeElementScreenshot((await element.getElement()).elementId), "base64");
  const image = sharp(png);
  if (topHeight !== undefined) {
    const { width } = await image.metadata();
    image.extract({ left: 0, top: 0, width, height: topHeight });
  }
  await encode(filename, image);
}

async function captureSettings(filename: string, first: string, last: string): Promise<void> {
  await browser.execute((ref) => {
    const root = document.querySelector(".langdock-sync-settings-header")?.parentElement;
    const row = Array.from(root?.children ?? []).find((item) =>
      item.querySelector(".setting-item-name")?.textContent === ref);
    if (!row) throw new Error(`Settings row missing: ${ref}`);
    row.scrollIntoView({ block: "start" });
  }, first);
  await prepareFrame();

  const region = await browser.execute((firstRef, lastRef) => {
    const root = document.querySelector(".langdock-sync-settings-header")?.parentElement;
    const rows = Array.from(root?.children ?? []);
    const start = rows.find((row) => row.querySelector(".setting-item-name")?.textContent === firstRef);
    const end = rows.find((row) => lastRef.startsWith(".")
      ? row.matches(lastRef) || row.querySelector(lastRef)
      : row.querySelector(".setting-item-name")?.textContent === lastRef);
    if (!start || !end) throw new Error(`Settings range missing: ${firstRef} / ${lastRef}`);

    const firstBounds = start.getBoundingClientRect();
    const lastBounds = end.getBoundingClientRect();
    return {
      left: Math.max(0, Math.floor(firstBounds.left) - 12),
      top: Math.floor(firstBounds.top),
      right: Math.min(innerWidth, Math.ceil(firstBounds.right) + 12),
      bottom: Math.ceil(lastBounds.bottom),
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  }, first, last);
  assert.ok(region.top >= 0 && region.bottom <= region.viewportHeight, `${filename} must fit in the viewport.`);

  const image = sharp(Buffer.from(await browser.takeScreenshot(), "base64"));
  const { width, height } = await image.metadata();
  const scaleX = width / region.viewportWidth;
  const scaleY = height / region.viewportHeight;
  await encode(filename, image.extract({
    left: Math.floor(region.left * scaleX),
    top: Math.floor(region.top * scaleY),
    width: Math.ceil(region.right * scaleX) - Math.floor(region.left * scaleX),
    height: Math.ceil(region.bottom * scaleY) - Math.floor(region.top * scaleY),
  }).extend({ top: 8, bottom: 8, left: 0, right: 0, background: "#fff" }));
}

async function setCaptureViewport(): Promise<void> {
  await browser.sendCommand("Emulation.setDeviceMetricsOverride", { ...dimensions, deviceScaleFactor: 1, mobile: false });
  assert.deepEqual(await browser.execute(() => [innerWidth, innerHeight, devicePixelRatio]), [
    dimensions.width, dimensions.height, 1,
  ]);
}

async function openCaptureSettings(): Promise<string> {
  const mainWindow = await openSettings();
  await setCaptureViewport();
  await expect($("body")).toHaveElementClass("theme-light");
  return mainWindow;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

describe("Langdock Sync documentation screenshots (opt-in)", () => {
  before(async () => {
    await mkdir(output, { recursive: true });
    await rm(join(output, "manifest.json"), { force: true });
    await rm(join(output, "index.html"), { force: true });
    const faqPath = "Knowledge/FAQ.md";
    const faq = await readFile(join(obsidianPage.getVaultPath(), faqPath), "utf8");
    await control({
      reset: true,
      folderNames: { writer: "Product handbook", viewer: "Support archive" },
      seed: [
        legacy("guide-old", "Knowledge/Support guide.md", "---\nclassification: public\n---\nUse the support form.\n"),
        legacy("faq-old", faqPath, "---\nclassification: public\n---\nRequest a copy of the FAQ.\n"),
        { ...legacy("faq-current", faqPath, faq), createdAt: "2026-01-15T10:00:00.000Z" },
      ],
    });
    await obsidianPage.write(".obsidian/plugins/langdock-sync/data.json", JSON.stringify({ language: "en" }));
    await setCaptureViewport();
    await obsidianPage.enablePlugin(pluginId);
    await expect($("body")).toHaveElementClass("theme-light");
  });

  it("captures the configured workflows and publishes a complete preview gallery", async () => {
    await expect($(".langdock-sync-introduction h3")).toHaveText("Welcome to Langdock Sync");
    await captureElement("introduction.webp", ".langdock-sync-introduction");
    await browser.keys("Escape");

    let mainWindow = await openCaptureSettings();
    await $('input[aria-label="Langdock API key"]').setValue("simulated-key");
    await $("button=Save key").click();
    await $('select[aria-label="Folders to sync"]:not([aria-hidden="true"])').selectByAttribute("value", "Knowledge");
    await expect($(".setting-item-name=Knowledge")).toExist();
    const target = 'select[aria-label="Knowledge base for Knowledge"]:not([aria-hidden="true"])';
    await expect($(`${target} option[value="writer"]`)).toHaveText("Product handbook");
    await $(target).selectByAttribute("value", "writer");
    await $("button=Test connection").click();
    await expect($('.langdock-sync-message--success[role="status"]')).toHaveText("Connection successful.");
    await captureSettings("connection.webp", "Langdock connection", ".langdock-sync-message--success");

    await captureSettings("manage-folders.webp", "Manage folders", "Knowledge");
    await expect($(".setting-item-name=classification = public")).toExist();
    await captureSettings("filters.webp", "Manage folders", "classification = public");
    await closeSettings(mainWindow);

    await browser.executeObsidianCommand("langdock-sync:preview-sync");
    const list = $(".modal-content ul");
    await expect(list).toHaveText(expect.stringContaining("Upload · Knowledge/Launch notes.md"));
    await expect(list).toHaveText(expect.stringContaining("Update · Knowledge/Support guide.md"));
    await expect(list).toHaveText(expect.stringContaining("Delete · Knowledge/FAQ.md (older copy)"));
    await captureElement("preview.webp", ".modal:has(.modal-title)");
    await browser.keys("Escape");

    await browser.executeObsidian(async ({ plugins }) => {
      const plugin = plugins.langdockSync;
      await plugin.syncNow();
      if (!plugin.status.lastSuccess || plugin.status.issues.length) throw new Error("The example sync did not complete.");
      plugin.status.lastSuccess = "2026-01-15T10:30:00.000Z";
    });
    const synced = await state();
    assert.deepEqual(synced.requests.filter(({ method }) => method === "POST" || method === "DELETE")
      .map(({ method }) => method).sort(), ["DELETE", "DELETE", "POST", "POST"]);
    mainWindow = await openCaptureSettings();
    await expect($(".langdock-sync-status .langdock-sync-message--success"))
      .toHaveText(expect.stringContaining("Last successful sync"));
    await captureSettings("sync-status.webp", "Sync automatically", ".langdock-sync-status");
    await closeSettings(mainWindow);

    await browser.executeObsidian(async ({ app }) => {
      const file = app.vault.getFileByPath("Knowledge/FAQ.md");
      if (!file) throw new Error("The example note is missing.");
      const leaf = app.workspace.getLeaf("split", "vertical");
      await leaf.openFile(file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
    });
    const noteView = ".workspace-leaf.mod-active .workspace-leaf-content";
    const noteBadge = $(`${noteView} .langdock-sync-note-action`);
    await expect(noteBadge).toHaveText("Synced");
    await expect($(".notice-container .notice")).not.toBeDisplayed();
    await captureElement("synced-note.webp", noteView, 126);
    await noteBadge.click();
    const fileStatus = ".langdock-sync-note-dialog";
    await expect($(`${fileStatus} .langdock-sync-note-status`)).toHaveText("Synced");
    await expect($(`${fileStatus} .langdock-sync-note-upload-time`)).toHaveAttribute("datetime", "2026-01-15T10:00:00.000Z");
    await captureElement("file-status.webp", fileStatus);
    await browser.keys("Escape");

    await browser.executeObsidianCommand("langdock-sync:show-about");
    await expect($(".langdock-sync-about .modal-title")).toHaveText("About Langdock Sync");
    await captureElement("about.webp", ".langdock-sync-about");
    await browser.keys("Escape");

    assert.deepEqual([...captured].sort(), assets.map(({ filename }) => filename).sort());
    const obsidianVersion = browser.getObsidianVersion();
    const gallery = assets.map(({ filename, description }) =>
      `<figure><img src="${escapeHtml(filename)}" alt="${escapeHtml(description)}"><figcaption>${escapeHtml(description)}</figcaption></figure>`).join("\n");
    await writeFile(join(output, "index.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Langdock Sync screenshots</title>
<style>
body { margin: 2rem auto; padding: 0 1rem; max-width: 72rem; font: 1rem system-ui; background: #f5f5f4; color: #222; }
main { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 28rem), 1fr)); gap: 1.25rem; }
figure { margin: 0; padding: 1rem; background: white; border-radius: .75rem; }
img { display: block; max-width: 100%; height: auto; }
figcaption { margin-top: .75rem; }
</style>
</head>
<body><h1>Langdock Sync screenshots</h1><p>Obsidian ${escapeHtml(obsidianVersion)}</p><main>${gallery}</main></body>
</html>
`);
    await writeFile(join(output, "manifest.json"), JSON.stringify({
      complete: true, obsidianVersion, viewport: dimensions, language: "en", theme: "light", assets,
    }, null, 2) + "\n");
  });
});
