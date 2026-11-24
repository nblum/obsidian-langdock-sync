import { $, $$, browser, expect } from "@wdio/globals";
import { obsidianPage } from "wdio-obsidian-service";
import { control, legacy, state } from "./mock-client.ts";
import type { RequestEntry } from "./mock-client.ts";
import { closeSettings, openSettings, waitFor } from "./obsidian-settings.ts";

const pluginId = "langdock-sync";
const approved = (label: string, body: string): string => `---\nclassification: ${label}\n---\n${body}\n`;

function mutations(requests: readonly RequestEntry[]): RequestEntry[] {
  return requests.filter(({ method }) => method === "POST" || method === "DELETE");
}

function blankPdf(): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  return pdf + `xref\n0 4\n0000000000 65535 f \n${offsets.join("")}trailer\n<< /Root 1 0 R /Size 4 >>\nstartxref\n${pdf.length}\n%%EOF\n`;
}

async function syncNow() {
  return browser.executeObsidian(async ({ plugins }) => {
    const plugin = plugins.langdockSync;
    await plugin.syncNow();
    return { lastSuccess: plugin.status.lastSuccess, issue: plugin.syncErrorText() };
  });
}

async function readStatus() {
  return browser.executeObsidian(({ plugins }) => ({ lastSuccess: plugins.langdockSync.status.lastSuccess, issue: plugins.langdockSync.syncErrorText(), busy: plugins.langdockSync.busy }));
}

describe("Langdock Sync in an isolated Obsidian vault", () => {
  beforeEach(async () => {
    await control({ reset: true });
    await browser.reloadObsidian({ vault: "tests/e2e/vault", plugins: [] });
    await obsidianPage.write(".obsidian/plugins/langdock-sync/data.json", JSON.stringify({
      folderId: "writer", folders: ["/"], propertyFilters: [], language: "de", introductionSeen: true,
    }));
    await browser.executeObsidian(({ app }) => {
      app.secretStorage.setSecret("langdock-api", "simulated-key");
    });
    await obsidianPage.enablePlugin(pluginId);
  });

  it("shows the next setup step while preview and manual sync are disabled", async () => {
    await browser.executeObsidian(async ({ app, plugins }) => {
      app.secretStorage.setSecret("langdock-api", "");
      await plugins.langdockSync.updateSettings({ folders: [] });
    });

    const mainWindow = await openSettings();
    const reason = $(".setting-item-name=Abgleich").$("..").$(".setting-item-description");
    const preview = () => $("button=Vorschau");
    const sync = () => $("button=Jetzt synchronisieren");
    await expect(reason).toHaveText("Hinterlege zuerst einen Langdock-API-Key.");
    await expect(preview()).toBeDisabled();
    await expect(sync()).toBeDisabled();

    await $('input[aria-label="Langdock-API-Key"]').setValue("simulated-key");
    await $("button=Key speichern").click();
    await expect(reason).toHaveText("Wähle eine Langdock-Wissensdatenbank mit Schreibrecht.");
    const target = 'select[aria-label="Wissensdatenbank"]:not([aria-hidden="true"])';
    await expect($(`${target} option[value="writer"]`)).toExist();
    await $(target).selectByAttribute("value", "writer");
    await expect(reason).toHaveText("Wähle mindestens einen Ordner für den Abgleich.");
    await expect(preview()).toBeDisabled();
    await expect(sync()).toBeDisabled();

    await $('select[aria-label="Ordner zur Synchronisierung"]:not([aria-hidden="true"])').selectByAttribute("value", "/");
    await expect(reason).toHaveText("");
    await expect(preview()).toBeEnabled();
    await expect(sync()).toBeEnabled();
    await closeSettings(mainWindow);
  });

  it("opens a single preview immediately and replaces progress with the plan or error", async () => {
    await obsidianPage.write("Preview.md", approved("public", "Preview this note."));
    const mainWindow = await openSettings();
    const settingsWindow = await browser.getWindowHandle();
    const dialog = $(".langdock-sync-preview");
    const progress = dialog.$("progress");

    await control({ holdInventory: true });
    try {
      await $("button=Vorschau").click();
      await expect(progress).toBeDisplayed();
      await expect(dialog.$('[role="status"]')).toHaveText("Vorschau wird vorbereitet …");
      await waitFor(async () => (await state()).requests.some(({ path }) => path === "/knowledge/writer/list"),
        "The preview did not request the inventory");

      if (settingsWindow !== mainWindow) await browser.switchToWindow(mainWindow);
      await browser.executeObsidianCommand("langdock-sync:preview-sync");
      if (settingsWindow !== mainWindow) {
        await expect(dialog).not.toExist();
        await browser.switchToWindow(settingsWindow);
      }
      expect((await $$(".langdock-sync-preview")).length).toBe(1);
    } finally {
      await control({ holdInventory: false });
    }

    await expect(dialog.$("ul")).toHaveText(expect.stringContaining("Hochladen · Preview.md"));
    await expect(progress).not.toExist();
    await browser.keys("Escape");
    await expect(dialog).not.toExist();
    await closeSettings(mainWindow);

    await control({ offline: true });
    await browser.executeObsidianCommand("langdock-sync:preview-sync");
    await expect(dialog.$('[role="alert"]')).toHaveText("Langdock-Anfrage fehlgeschlagen (GET, HTTP 503).");
    await expect(progress).not.toExist();
    await browser.keys("Escape");
  });

  it("previews, checks role and connection, uploads eligible local bytes and adopts a Python upload", async () => {
    const publicPath = "Öffentliche Notiz.md";
    const publicNote = "\uFEFF---\r\nclassification: public\r\n---\r\nGrüße\r\n";
    const internalNote = approved("internal", "Local only");
    const legacyNote = approved("internal", "Already in Langdock");
    await control({ seed: [legacy("legacy", "Python.md", legacyNote)] });
    await browser.executeObsidian(async ({ app }, path, text) => {
      await app.vault.createBinary(path, new TextEncoder().encode(text).buffer);
    }, publicPath, publicNote);
    await obsidianPage.write("Local.md", internalNote);
    await obsidianPage.write("Python.md", legacyNote);
    await obsidianPage.write("Excluded.md", "---\nclassification: public\nlangdock_sync: false\n---\nSkip\n");
    await obsidianPage.write("Confidential.md", approved("confidential", "Private"));
    await obsidianPage.write("Ambiguous.md", "---\nclassification: public\nclassification: internal\n---\n");
    await obsidianPage.write("_META.md", approved("public", "Hidden metadata"));
    await obsidianPage.write(".hidden/Hidden.md", approved("public", "Hidden path"));

    const automatic = await browser.executeObsidian(({ plugins }) => plugins.langdockSync.config.automatic);
    expect(automatic).toBe(false);
    await browser.executeObsidian(({ app }) => {
      app.secretStorage.setSecret("langdock-api", "previous-simulated-key");
    });
    const mainWindow = await openSettings();
    const key = () => $('input[aria-label="Langdock-API-Key"][type="password"]');
    const connectionHeading = await browser.execute(() =>
      document.querySelector('input[aria-label="Langdock-API-Key"]')?.closest(".setting-item")
        ?.previousElementSibling?.querySelector(".setting-item-name")?.textContent,
    );
    expect(connectionHeading).toBe("Langdock Verbindung");
    const apiSettingsLink = $('.langdock-sync-help a[href="https://app.langdock.com/settings/workspace/products/api"]');
    await expect(apiSettingsLink).toHaveText("Langdock-API-Einstellungen");
    await expect(apiSettingsLink).toHaveAttribute("target", "_blank");
    await expect(apiSettingsLink).toHaveAttribute("rel", "noopener");
    await expect(apiSettingsLink.$(".."))
      .toHaveText(expect.stringContaining("Workspace-API-Key mit der Berechtigung für die Knowledge Folder API (KNOWLEDGE_FOLDER_API)"));
    await expect(key()).toHaveValue("");
    await key().setValue("simulated-key");
    await $("button=Key speichern").click();
    const selector = 'select[aria-label="Wissensdatenbank"]:not([aria-hidden="true"])';
    await expect($(`${selector} option[value="viewer"]`)).toHaveAttribute("disabled");
    await expect($(selector)).toHaveValue("");
    await expect(key()).toHaveValue("");
    await $(selector).selectByAttribute("value", "writer");
    await expect($(selector)).toHaveValue("writer");
    await $("button=Verbindung testen").click();
    await expect($('.langdock-sync-message--success[role="status"]')).toHaveText("Verbindung erfolgreich.");
    await expect($(".langdock-sync-status .langdock-sync-message--info"))
      .toHaveText("Letzter erfolgreicher Abgleich · noch keiner");
    const accents = await browser.execute(() => Array.from(
      document.querySelectorAll(".langdock-sync-message"), (panel) => getComputedStyle(panel).borderInlineStartColor,
    ));
    expect(new Set(accents).size).toBe(2);
    await closeSettings(mainWindow);

    await browser.executeObsidianCommand("langdock-sync:preview-sync");
    const preview = $(".modal-content ul");
    await expect(preview).toHaveText(expect.stringContaining("Hochladen · Öffentliche Notiz.md"));
    await expect(preview).toHaveText(expect.stringContaining("Hochladen · Local.md"));
    await expect(preview).not.toHaveText(expect.stringContaining("Python.md"));
    expect(mutations((await state()).requests)).toHaveLength(0);
    await browser.keys("Escape");

    await browser.executeObsidianCommand("langdock-sync:sync-now");
    await waitFor(async () => Boolean((await readStatus()).lastSuccess), "Manual command did not finish");
    const first = await state();
    expect(first.files.map(({ name }) => name).sort()).toEqual([
      legacy("expected", "Local.md", internalNote).name,
      legacy("expected", publicPath, publicNote).name,
      legacy("legacy", "Python.md", legacyNote).name,
    ].sort());
    expect(first.files.find(({ name }) => name.startsWith("Öffentliche"))?.bytes).toBe(Buffer.from(publicNote).toString("base64"));
    expect(first.files.some(({ id }) => id === "legacy")).toBe(true);
    expect(mutations(first.requests).map(({ method }) => method)).toEqual(["POST", "POST"]);
    expect((await syncNow()).issue).toBeNull();
    expect(mutations((await state()).requests)).toHaveLength(2);
    const data = await browser.executeObsidian(async ({ plugins }) => await plugins.langdockSync.loadData() as unknown);
    expect(data).toMatchObject({ folderId: "writer", automatic: false });
    expect(data).not.toHaveProperty("secretId");
    expect(await browser.executeObsidian(({ app }) => app.secretStorage.getSecret("langdock-api") === "simulated-key")).toBe(true);
    expect(JSON.stringify(data)).not.toContain("simulated-key");
    const settingsWindow = await openSettings();
    await expect($(".langdock-sync-status .langdock-sync-message--success"))
      .toHaveText(expect.stringContaining("Letzter erfolgreicher Abgleich · "));
    await closeSettings(settingsWindow);
  });

  it("migrates a previously selected secret and preserves an existing fixed entry", async () => {
    await browser.executeObsidian(async ({ app, plugins }) => {
      app.secretStorage.setSecret("langdock-api", "");
      app.secretStorage.setSecret("previous", "simulated-key");
      await plugins.langdockSync.saveData({ secretId: "previous", folderId: "writer", introductionSeen: true });
    });
    await obsidianPage.disablePlugin(pluginId);
    await obsidianPage.enablePlugin(pluginId);

    const migrated = await browser.executeObsidian(async ({ app, plugins }) => ({
      kept: app.secretStorage.getSecret("previous") === "simulated-key",
      copied: app.secretStorage.getSecret("langdock-api") === "simulated-key",
      data: await plugins.langdockSync.loadData() as unknown,
    }));
    expect(migrated.kept).toBe(true);
    expect(migrated.copied).toBe(true);
    expect(migrated.data).toMatchObject({ folderId: "writer", automatic: false });
    expect(migrated.data).not.toHaveProperty("secretId");

    await browser.executeObsidian(async ({ app, plugins }) => {
      app.secretStorage.setSecret("previous", "different-key");
      await plugins.langdockSync.saveData({ secretId: "previous", folderId: "writer", automatic: true, introductionSeen: true });
    });
    await obsidianPage.disablePlugin(pluginId);
    await obsidianPage.enablePlugin(pluginId);
    const conflict = await browser.executeObsidian(({ app, plugins }) => ({
      config: plugins.langdockSync.config,
      kept: app.secretStorage.getSecret("langdock-api") === "simulated-key",
    }));
    expect(conflict).toMatchObject({ config: { folderId: "", automatic: false }, kept: true });
    expect((await state()).requests).toHaveLength(0);
  });

  it("requires a folder and applies the default and edited property filters", async () => {
    const publicPath = "Share/Sub/Public.md";
    const internalPath = "Share/Internal.md";
    const outsidePath = "Shared/Outside.md";
    const publicNote = approved("public", "In scope by default");
    const internalNote = "---\nclassification: internal\naudience: [ops, team]\n---\nInternal\n";
    const outsideNote = approved("public", "Similar prefix outside the selected folder");
    await obsidianPage.write(publicPath, publicNote);
    await obsidianPage.write(internalPath, internalNote);
    await obsidianPage.write(outsidePath, outsideNote);
    await browser.executeObsidian(async ({ plugins }) => {
      await plugins.langdockSync.saveData({ folderId: "writer", automatic: true, language: "de", introductionSeen: true });
    });
    await obsidianPage.disablePlugin(pluginId);
    await obsidianPage.enablePlugin(pluginId);

    expect((await syncNow()).issue).toContain("mindestens einen Ordner");
    expect((await state()).requests).toHaveLength(0);
    let mainWindow = await openSettings();
    await expect($(".langdock-sync-status .langdock-sync-message--error"))
      .toHaveText(expect.stringContaining("mindestens einen Ordner"));
    const headings = await browser.execute(() =>
      Array.from(document.querySelectorAll(".setting-item-heading + .langdock-sync-content-row"), (row) => ({
        title: row.previousElementSibling?.querySelector(".setting-item-name")?.textContent,
        text: row.querySelector(".langdock-sync-help")?.textContent,
      })));
    expect(headings).toEqual([
      { title: "Ordner verwalten", text: expect.stringContaining("mindestens einen Ordner") },
      { title: "Eigenschaften verwalten", text: expect.stringContaining("Beispiel: classification muss public oder internal sein, und topic muss handbook sein.") },
    ]);
    await expect($(".langdock-sync-help strong"))
      .toHaveText("Gleiche Eigenschaft: ODER. Unterschiedliche Eigenschaften: UND.");
    await expect($(".setting-item-name=classification = public")).toExist();
    await expect($('.langdock-sync-help a[href="https://github.com/nblum/obsidian-classificator"]')).toExist();
    const folders = $('select[aria-label="Ordner zur Synchronisierung"]:not([aria-hidden="true"])');
    await folders.selectByAttribute("value", "Share");
    await expect($(".setting-item-name=Share")).toExist();
    await closeSettings(mainWindow);
    expect((await syncNow()).issue).toBeNull();
    expect((await state()).files.map(({ name }) => name)).toEqual([legacy("expected", publicPath, publicNote).name]);

    mainWindow = await openSettings();
    await $('input[aria-label="YAML-Eigenschaft"]').setValue("audience");
    await $('input[aria-label="Erlaubter YAML-Wert"]').setValue("team");
    await $("button=Filter hinzufügen").click();
    await expect($(".setting-item-name=audience = team")).toExist();
    await $('[aria-label="Filter entfernen (classification = public)"]').click();
    await expect($(".setting-item-name=classification = public")).not.toExist();
    await closeSettings(mainWindow);

    expect((await syncNow()).issue).toBeNull();
    expect((await state()).files.map(({ name }) => name)).toEqual([legacy("expected", internalPath, internalNote).name]);
  });

  it("switches languages without losing the current sync error and follows the Obsidian language in Auto", async () => {
    await browser.executeObsidian(async ({ plugins }) => {
      await plugins.langdockSync.updateSettings({ folders: [] });
    });
    expect((await syncNow()).issue).toContain("mindestens einen Ordner");

    const languageSelect = (label: string) => $(`select[aria-label="${label}"]:not([aria-hidden="true"])`);
    let mainWindow = await openSettings();
    await languageSelect("Sprache").selectByAttribute("value", "fr");
    await expect($(".setting-item-name=Connexion à Langdock")).toExist();
    await expect($('.langdock-sync-help a[href="https://app.langdock.com/settings/workspace/products/api"]'))
      .toHaveText("paramètres API de Langdock");
    await expect($(".langdock-sync-status .langdock-sync-message--error"))
      .toHaveText("Sélectionnez au moins un dossier à synchroniser.");
    await closeSettings(mainWindow);
    const commandNames = await browser.executeObsidian(({ app }) => {
      const { commands } = app as unknown as { commands: { commands: Record<string, { name: string }> } };
      return ["sync-now", "preview-sync", "show-introduction", "show-about"]
        .map((id) => commands.commands[`langdock-sync:${id}`]?.name);
    });
    expect(commandNames).toEqual([
      "Langdock Sync: Synchroniser maintenant",
      "Langdock Sync: Afficher l’aperçu de la synchronisation",
      "Langdock Sync: Afficher l’introduction",
      "Langdock Sync: À propos de Langdock Sync",
    ]);

    await obsidianPage.disablePlugin(pluginId);
    await obsidianPage.enablePlugin(pluginId);
    mainWindow = await openSettings();
    await expect(languageSelect("Langue")).toHaveValue("fr");
    await expect($(".langdock-sync-status .langdock-sync-message--error"))
      .toHaveText("Sélectionnez au moins un dossier à synchroniser.");
    await closeSettings(mainWindow);

    await browser.executeObsidian(async ({ plugins }) => {
      await plugins.langdockSync.updateSettings({ folders: ["/"] });
    });
    await browser.executeObsidianCommand("langdock-sync:preview-sync");
    await expect($(".modal-title")).toHaveText("Langdock Sync · Aperçu");
    await expect($(".modal-content p")).toHaveText("Aucune modification prévue.");
    await browser.keys("Escape");

    const obsidianLanguage = await browser.executeObsidian(({ obsidian }) => obsidian.getLanguage());
    expect(obsidianLanguage).toBe("en");
    const hasSettingsSearch = await browser.executeObsidian(({ obsidian }) => obsidian.requireApiVersion("1.13.0"));
    mainWindow = await openSettings();
    await languageSelect("Langue").selectByAttribute("value", "auto");
    await expect($(".setting-item-name=Langdock connection")).toExist();
    await expect(languageSelect("Language")).toHaveValue("auto");
    if (hasSettingsSearch) {
      for (const name of ["Sync automatically", "Sync interval", "Show sync button in files", "Attachment extensions"]) {
        await $(".setting-search-container input").setValue(name);
        const result = $(`.vertical-tab-nav-item-title=${name}`);
        await expect(result).toBeDisplayed();
        await result.click();
        await expect($(`.setting-item-name=${name}`)).toBeDisplayed();
      }
    }
    await closeSettings(mainWindow);
  });

  it("shows per-note status and syncs only the eligible note from its overlay", async () => {
    const path = "Knowledge/Guide.md";
    const original = approved("public", "First version");
    const changed = approved("public", "Revised version");
    const other = approved("public", "Another local note");
    const orphan = { ...legacy("orphan", "Knowledge/Removed.md", other), createdAt: "2026-01-15T10:00:00.000Z" };
    await control({ seed: [orphan] });
    await browser.executeObsidian(async ({ app, plugins }, path, original, other) => {
      await app.vault.createFolder("Knowledge");
      await app.vault.create("Knowledge/Other.md", other);
      await app.vault.create("Knowledge/Excluded.md", "---\nclassification: public\nlangdock_sync: false\n---\nExcluded");
      await app.vault.create("Outside.md", other);
      const file = await app.vault.create(path, original);
      await plugins.langdockSync.updateSettings({ folders: ["Knowledge"] });
      await app.workspace.getLeaf(false).openFile(file);
    }, path, original, other);

    const noteButtonSelector = ".view-action.langdock-sync-note-action";
    const noteButton = () => $(noteButtonSelector);
    const overlay = () => $(".langdock-sync-note-dialog");
    const overlayStatus = () => overlay().$(".langdock-sync-note-status");
    const uploadTime = () => overlay().$(".langdock-sync-note-upload-time");
    const syncButton = () => overlay().$("button=Jetzt synchronisieren");
    const expectUploadTime = async (id: string) => {
      const uploadedAt = (await state()).files.find((file) => file.id === id)?.createdAt;
      if (!uploadedAt) throw new Error(`Missing upload timestamp for ${id}`);
      const localTime = await browser.execute((timestamp) => new Date(timestamp).toLocaleString("de"), uploadedAt);
      await expect(uploadTime()).toBeDisplayed();
      await expect(uploadTime()).toHaveAttribute("datetime", uploadedAt);
      await expect(uploadTime()).toHaveText(`Upload der indexierten Kopie · ${localTime}`);
    };
    const expectStatusColor = async (status: string, color: string) => {
      await expect(noteButton()).toHaveAttribute("data-state", status);
      const matches = await browser.execute((selector, color) => {
        const button = document.querySelector(selector);
        if (!button) return false;
        const style = getComputedStyle(button);
        const accent = style.getPropertyValue("--langdock-note-accent").trim();
        return !!accent && accent === style.getPropertyValue(`--color-${color}`).trim();
      }, noteButtonSelector, color);
      expect(matches).toBe(true);
    };
    await expectStatusColor("unsynced", "purple");
    await expect(noteButton()).toHaveText("Nicht synchronisiert");
    expect(mutations((await state()).requests)).toHaveLength(0);

    await browser.executeObsidian(({ app, obsidian }) => {
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      if (!view) throw new Error("The test note view is missing");
      const badge = view.addAction("tag", "Classify", () => {});
      badge.addClass("classificator-badge--header");
      badge.parentElement?.append(badge);
    });
    const besideClassificator = () => $(`.classificator-badge--header + ${noteButtonSelector}`);
    await expect(besideClassificator()).toBeDisplayed();

    const toggleNoteButton = async () => {
      const mainWindow = await openSettings();
      await $(".setting-item-name=Sync-Schaltfläche in Dateien anzeigen").$("../..").$(".checkbox-container").click();
      await closeSettings(mainWindow);
    };
    const savedVisibility = () => browser.executeObsidian(async ({ plugins }) => {
      const data = await plugins.langdockSync.loadData() as { showNoteSyncButton?: boolean };
      return data.showNoteSyncButton;
    });
    await toggleNoteButton();
    await expect(noteButton()).not.toExist();
    await waitFor(async () => await savedVisibility() === false, "The disabled note sync button preference was not saved");
    await obsidianPage.disablePlugin(pluginId);
    await obsidianPage.enablePlugin(pluginId);
    await expect(noteButton()).not.toExist();
    await toggleNoteButton();
    await expectStatusColor("unsynced", "purple");
    await expect(besideClassificator()).toBeDisplayed();

    await noteButton().click();
    await expect(overlay().$(".langdock-sync-note-path")).toHaveText(path);
    await expect(overlayStatus()).toHaveAttribute("data-state", "unsynced");
    await expect(uploadTime()).not.toBeDisplayed();
    await syncButton().click();
    await expect(overlayStatus()).toHaveAttribute("data-state", "synced");
    await expectUploadTime("upload-1");
    await expectStatusColor("synced", "blue");
    await browser.keys("Escape");

    await browser.executeObsidian(async ({ app }, path, changed) => {
      const file = app.vault.getFileByPath(path);
      if (!file) throw new Error("The test note is missing");
      await app.vault.modify(file, changed);
      const leaf = app.workspace.getLeaf(false);
      const view = leaf.getViewState();
      await leaf.setViewState({ ...view, state: { ...view.state, mode: "preview" } });
    }, path, changed);
    await expectStatusColor("outdated", "yellow");
    await expect(noteButton()).toHaveText("Veraltet");
    await noteButton().click();
    await expect(overlayStatus()).toHaveAttribute("data-state", "outdated");
    await expectUploadTime("upload-1");
    await syncButton().click();
    await expect(overlayStatus()).toHaveAttribute("data-state", "synced");
    await expectUploadTime("upload-2");
    await browser.keys("Escape");

    const result = await state();
    expect(result.files.map(({ name }) => name).sort()).toEqual([orphan.name, legacy("updated", path, changed).name].sort());
    expect(mutations(result.requests).map(({ method, id }) => [method, id]))
      .toEqual([["POST", "upload-1"], ["POST", "upload-2"], ["DELETE", "upload-1"]]);

    const openNote = async (path: string) => {
      await browser.executeObsidian(async ({ app }, path) => {
        const file = app.vault.getFileByPath(path);
        if (!file) throw new Error("The test note is missing");
        await app.workspace.getLeaf(false).openFile(file);
      }, path);
    };
    for (const excluded of ["Outside.md", "Knowledge/Excluded.md"]) {
      await openNote(excluded);
      await expect(noteButton()).not.toExist();
    }
    await openNote(path);
    await expect(noteButton()).toBeDisplayed();
    await obsidianPage.disablePlugin(pluginId);
    await expect(noteButton()).not.toExist();
    await obsidianPage.enablePlugin(pluginId);
    await expectStatusColor("synced", "blue");
  });

  it("syncs an approved PDF from its file header and reacts to reclassification in _meta.md", async () => {
    const path = "Knowledge/Guide.PDF";
    const metadataPath = "Knowledge/_meta.md";
    const pdf = blankPdf();
    await browser.executeObsidian(async ({ app, plugins }, path, pdf, metadataPath) => {
      await app.vault.createFolder("Knowledge");
      await app.vault.create(metadataPath, "---\nclassification: internal\nattachment-classifications:\n  Guide.PDF: public\n  Source.txt: public\n---\n");
      const file = await app.vault.createBinary(path, new TextEncoder().encode(pdf).buffer);
      await app.vault.createBinary("Knowledge/Unlisted.pdf", new TextEncoder().encode(pdf).buffer);
      await app.vault.create("Knowledge/Source.txt", "An approved attachment of an unchecked format.");
      await plugins.langdockSync.updateSettings({
        folders: ["Knowledge"], propertyFilters: [{ property: "classification", value: "public" }],
        attachmentExtensions: "txt",
      });
      await app.workspace.getLeaf(false).openFile(file);
    }, path, pdf, metadataPath);

    const fileButton = () => $('.workspace-leaf-content[data-type="pdf"] .langdock-sync-note-action');
    await expect(fileButton()).not.toExist();
    let mainWindow = await openSettings();
    const extensions = () => $('[role="group"][aria-label="Dateiendungen für Anhänge"]');
    const option = (value: string) => extensions().$(`input[type="checkbox"][value="${value}"]`);
    const save = () => $("button=Endungen speichern");
    await expect(option("txt")).toBeChecked();
    await expect(option("pdf")).not.toBeChecked();
    await expect(option("png")).not.toExist();
    await expect(save()).toBeDisabled();
    await option("pdf").click();
    await option("docx").click();
    await option("txt").click();
    await expect(save()).toBeEnabled();
    await save().click();
    await expect(save()).toBeDisabled();
    await closeSettings(mainWindow);
    const saved = await browser.executeObsidian(async ({ plugins }) => await plugins.langdockSync.loadData() as unknown);
    expect(saved).toMatchObject({ attachmentExtensions: "pdf,docx" });

    await obsidianPage.disablePlugin(pluginId);
    await obsidianPage.enablePlugin(pluginId);
    mainWindow = await openSettings();
    await expect(option("pdf")).toBeChecked();
    await expect(option("docx")).toBeChecked();
    await expect(option("txt")).not.toBeChecked();
    await closeSettings(mainWindow);

    await expect(fileButton()).toHaveAttribute("data-state", "unsynced");
    await browser.executeObsidianCommand("langdock-sync:preview-sync");
    await expect($(".langdock-sync-preview li")).toHaveText(`Hochladen · ${path}`);
    expect(await $$(".langdock-sync-preview li")).toHaveLength(1);
    expect(mutations((await state()).requests)).toHaveLength(0);
    await browser.keys("Escape");

    await fileButton().click();
    const overlay = () => $(".langdock-sync-note-dialog");
    await expect(overlay().$(".langdock-sync-note-path")).toHaveText(path);
    await expect(overlay().$(".langdock-sync-note-status")).toHaveAttribute("data-state", "unsynced");
    await overlay().$("button=Jetzt synchronisieren").click();
    await expect(overlay().$(".langdock-sync-note-status")).toHaveAttribute("data-state", "synced");
    await browser.keys("Escape");
    await expect(fileButton()).toHaveAttribute("data-state", "synced");
    const uploaded = (await state()).files;
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]?.name).toMatch(/^Guide--obsidian-nblum-[a-f0-9]{32}-[a-f0-9]{32}\.pdf$/u);
    expect(uploaded[0]?.bytes).toBe(Buffer.from(pdf).toString("base64"));
    const manual = await syncNow();
    expect(manual.issue).toBeNull();
    expect(mutations((await state()).requests).map(({ method }) => method)).toEqual(["POST"]);

    await browser.executeObsidian(async ({ plugins }) => {
      await plugins.langdockSync.updateSettings({ automatic: true });
    });
    await waitFor(async () => (await readStatus()).lastSuccess !== manual.lastSuccess, "Initial automatic run did not finish");
    await browser.executeObsidian(async ({ app }, metadataPath) => {
      const metadata = app.vault.getFileByPath(metadataPath);
      if (!metadata) throw new Error("The folder metadata is missing");
      await app.vault.modify(metadata, "---\nclassification: public\nattachment-classifications:\n  Guide.PDF: internal\n---\n");
    }, metadataPath);
    await expect(fileButton()).not.toExist();
    await waitFor(async () => (await state()).files.length === 0, "Reclassification did not remove the managed PDF");
    expect(mutations((await state()).requests).map(({ method }) => method)).toEqual(["POST", "DELETE"]);
  });

  it("shows the introduction once and reopens the help dialogs from settings and commands", async () => {
    await browser.executeObsidian(async ({ plugins }) => {
      await plugins.langdockSync.saveData({ language: "de", introductionSeen: false });
    });
    await obsidianPage.disablePlugin(pluginId);
    await obsidianPage.enablePlugin(pluginId);

    const intro = () => $(".langdock-sync-introduction");
    const continueButton = () => intro().$("button.mod-cta");
    const progress = () => intro().$(".langdock-sync-introduction-progress");
    await expect(intro().$(".modal-title")).toHaveText("Einführung in Langdock Sync");
    await expect(intro().$("h3")).toHaveText("Langdock verbinden");
    await expect(progress()).toHaveText("Schritt 1 von 3");
    await continueButton().click();
    await expect(intro().$("h3")).toHaveText("Notizen auswählen");
    await expect(progress()).toHaveText("Schritt 2 von 3");
    await intro().$("button=Zurück").click();
    await expect(progress()).toHaveText("Schritt 1 von 3");
    await continueButton().click();
    await continueButton().click();
    await expect(intro().$("h3")).toHaveText("Ersten Abgleich starten");
    await expect(continueButton()).toHaveText("Fertig");
    await continueButton().click();
    await expect(intro()).not.toExist();
    const saved = await browser.executeObsidian(async ({ plugins }) => await plugins.langdockSync.loadData() as unknown);
    expect(saved).toMatchObject({ introductionSeen: true, automatic: false });

    await browser.reloadObsidian({ plugins: [pluginId] });
    await expect(intro()).not.toExist();
    await browser.executeObsidianCommand("langdock-sync:show-introduction");
    await expect(progress()).toHaveText("Schritt 1 von 3");
    await browser.keys("Escape");
    await expect(intro()).not.toExist();

    await browser.executeObsidianCommand("langdock-sync:show-about");
    const about = () => $(".langdock-sync-about");
    const version = await browser.executeObsidian(({ plugins }) => plugins.langdockSync.manifest.version);
    await expect(about().$(".modal-title")).toHaveText("Über Langdock Sync");
    await expect(about().$(".langdock-sync-about-meta")).toHaveText(expect.stringContaining(`Version ${version}`));
    await expect(about().$(".langdock-sync-about-meta")).toHaveText(expect.stringContaining("Nico Blum"));
    await expect(about().$('a[href="https://github.com/nblum/obsidian-langdock-sync#readme"]')).toHaveAttribute("rel", "noopener");
    await expect(about().$('a[href="https://github.com/nblum/obsidian-langdock-sync/issues/new"]')).toHaveText("Feedback geben");
    await about().$("button=Schließen").click();
    await expect(about()).not.toExist();

    const mainWindow = await openSettings();
    const topControls = await browser.execute(() => {
      const languageRow = document.querySelector('select[aria-label="Sprache"]')?.closest(".setting-item");
      const header = languageRow?.previousElementSibling;
      const helpRow = languageRow?.nextElementSibling;
      return {
        headerFirst: header?.previousElementSibling === null,
        title: header?.querySelector(".setting-item-name")?.textContent,
        description: header?.querySelector(".setting-item-description > p")?.textContent,
        buttons: Array.from(helpRow?.querySelectorAll("button") ?? [], (button) => button.textContent),
        nextHeading: helpRow?.nextElementSibling?.querySelector(".setting-item-name")?.textContent,
      };
    });
    expect(topControls).toEqual({
      headerFirst: true,
      title: "Langdock Sync",
      description: "Synchronisiert freigegebene Markdown-Notizen und Anhänge aus Obsidian mit einer Langdock-Wissensdatenbank.",
      buttons: ["Einführung anzeigen", "Über Langdock Sync"],
      nextHeading: "Langdock Verbindung",
    });
    const settingsHeader = $(".langdock-sync-settings-header");
    await expect(settingsHeader.$(".langdock-sync-about-meta")).toHaveText(expect.stringContaining(`Version ${version}`));
    await expect(settingsHeader.$(".langdock-sync-about-meta")).toHaveText(expect.stringContaining("Nico Blum"));
    await expect(settingsHeader.$('a[href="https://github.com/nblum/obsidian-langdock-sync#readme"]')).toHaveText("Dokumentation");
    await $("button=Über Langdock Sync").click();
    await expect(about().$(".modal-title")).toHaveText("Über Langdock Sync");
    await about().$("button=Schließen").click();
    await $("button=Einführung anzeigen").click();
    await expect(progress()).toHaveText("Schritt 1 von 3");
    await browser.keys("Escape");
    await closeSettings(mainWindow);
    expect((await state()).requests).toHaveLength(0);
  });

  it("applies revocation, deletion and rename while preserving a manual upload", async () => {
    const note = approved("internal", "Existing note");
    const manual = { id: "manual", name: "Manual.md", syncStatus: "SYNCED" };
    await control({ seed: [
      legacy("revoked", "Revoked.md", note),
      legacy("removed", "Removed.md", note),
      legacy("renamed", "Before.md", note),
      manual,
    ] });
    await obsidianPage.write("Revoked.md", approved("confidential", "Revoked"));
    await obsidianPage.write("Removed.md", note);
    await obsidianPage.write("Before.md", note);
    await browser.executeObsidian(async ({ app }) => {
      const before = app.vault.getFileByPath("Before.md");
      const removed = app.vault.getFileByPath("Removed.md");
      if (!before || !removed) throw new Error("Test notes are missing");
      await app.vault.rename(before, "After.md");
      await app.vault.delete(removed);
    });
    expect((await syncNow()).issue).toBeNull();
    const result = await state();
    expect(result.files.map(({ name }) => name).sort()).toEqual([legacy("expected", "After.md", note).name, manual.name].sort());
    expect(mutations(result.requests).filter(({ method }) => method === "DELETE").map(({ id }) => id).sort())
      .toEqual(["removed", "renamed", "revoked"]);
  });

  it("retains the searchable version until a retry is indexed", async () => {
    const path = "Update.md";
    const original = approved("public", "Searchable version");
    const changed = approved("public", "New version");
    await control({ seed: [legacy("old", path, original)], nextStatus: "EXTRACTION_FAILED" });
    await obsidianPage.write(path, changed);

    const failed = await syncNow();
    expect(failed.issue).toContain("Update.md");
    expect(failed.issue).toContain("EXTRACTION_FAILED");
    expect(failed.lastSuccess).toBeNull();
    expect((await state()).files.map(({ id }) => id)).toEqual(["old", "upload-1"]);

    await control({ nextStatus: "EMBEDDING" });
    await browser.executeObsidianCommand("langdock-sync:sync-now");
    await waitFor(async () => (await state()).requests.some(({ id, syncStatus }) => id === "upload-2" && syncStatus === "EMBEDDING"),
      "Replacement did not start indexing");
    expect((await state()).files.map(({ id }) => id)).toEqual(["old", "upload-1", "upload-2"]);
    await control({ statuses: { "upload-2": "SYNCED" } });
    await waitFor(async () => !(await readStatus()).busy, "Replacement did not finish indexing");

    const updated = await state();
    expect(updated.files.map(({ id }) => id)).toEqual(["upload-2"]);
    const confirmed = updated.requests.findIndex(({ id, syncStatus }) => id === "upload-2" && syncStatus === "SYNCED");
    const deleted = updated.requests.findIndex(({ id, method }) => id === "old" && method === "DELETE");
    expect(confirmed).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeGreaterThan(confirmed);
    expect((await readStatus()).issue).toBeNull();
  });

  it("resumes a pending upload and reconciles offline edits on Obsidian restart", async () => {
    const path = "Resume.md";
    const note = approved("public", "Pending release");
    await control({ seed: [legacy("pending", path, note, "EXTRACTING")], offline: true });
    await obsidianPage.write(path, note);
    await obsidianPage.write("Offline.md", approved("internal", "Saved while offline"));
    await browser.executeObsidian(async ({ plugins }) => {
      await plugins.langdockSync.updateSettings({ automatic: true });
    });
    await waitFor(async () => (await readStatus()).issue?.includes("503") === true, "The offline error did not surface");
    await control({ offline: false });
    await browser.reloadObsidian({ plugins: [pluginId] });
    const restored = await browser.executeObsidian(({ app, plugins }) => ({
      automatic: plugins.langdockSync.config.automatic,
      keyAvailable: app.secretStorage.getSecret("langdock-api") === "simulated-key",
    }));
    expect(restored).toEqual({ automatic: true, keyAvailable: true });

    await waitFor(async () => (await state()).requests.some(({ id, syncStatus }) => id === "pending" && syncStatus === "EXTRACTING"),
      "The restarted plugin did not resume the existing upload");
    await control({ statuses: { pending: "SYNCED" } });
    await waitFor(async () => Boolean((await readStatus()).lastSuccess), "The restarted plugin did not finish recovery");
    const result = await state();
    expect(result.files.map(({ id }) => id).sort()).toEqual(["pending", "upload-1"]);
    expect(mutations(result.requests).map(({ method }) => method)).toEqual(["POST"]);
  });

  it("debounces rapid vault modifications into the most recent content", async () => {
    await obsidianPage.write("Burst.md", approved("confidential", "Initially excluded"));
    await browser.executeObsidian(async ({ plugins }) => {
      await plugins.langdockSync.updateSettings({ automatic: true });
    });
    await waitFor(async () => Boolean((await readStatus()).lastSuccess), "Initial automatic run did not finish");
    const versions = ["First", "Second", "Final"].map((body) => approved("public", body));
    await browser.executeObsidian(async ({ app }, contents) => {
      const file = app.vault.getFileByPath("Burst.md");
      if (!file) throw new Error("Test note is missing");
      for (const content of contents) await app.vault.modify(file, content);
    }, versions);
    await waitFor(async () => (await state()).files.length === 1 && !(await readStatus()).busy, "The debounced sync did not finish");
    const result = await state();
    expect(result.files[0]?.bytes).toBe(Buffer.from(versions[2] ?? "").toString("base64"));
    expect(mutations(result.requests).map(({ method }) => method)).toEqual(["POST"]);
  });

  it("saves an optional hourly sync and checks again without vault changes", async () => {
    const mainWindow = await openSettings();
    const interval = () => $('select[aria-label="Sync-Intervall"]:not([aria-hidden="true"])');
    await expect(interval()).toBeDisabled();
    await expect(interval()).toHaveValue("0");
    await $(".setting-item-name=Automatisch synchronisieren").$("../..").$(".checkbox-container").click();
    await expect(interval()).toBeEnabled();
    await interval().selectByAttribute("value", "60");
    await closeSettings(mainWindow);
    await waitFor(async () => {
      const saved = await browser.executeObsidian(async ({ plugins }) => {
        const data = await plugins.langdockSync.loadData() as { syncIntervalMinutes?: number } | null;
        return data?.syncIntervalMinutes;
      });
      return saved === 60;
    }, "The hourly interval was not saved");

    await obsidianPage.disablePlugin(pluginId);
    const checks = async () => (await state()).requests.filter(({ path }) => path === "/knowledge/writer/list").length;
    const before = await checks();
    await browser.executeObsidian(() => {
      // Run the real hourly timer on a shorter interval inside the fixture vault.
      const browserWindow: Window = window;
      const setInterval = browserWindow.setInterval.bind(browserWindow);
      browserWindow.setInterval = (handler, delay, ...args: unknown[]) => {
        if (delay !== 3_600_000) return setInterval(handler, delay, ...args);
        browserWindow.setInterval = setInterval;
        return setInterval(handler, 3_000, ...args);
      };
    });
    await obsidianPage.enablePlugin(pluginId);
    await waitFor(async () => await checks() >= before + 2, "The hourly timer did not sync after the startup check");
    expect(mutations((await state()).requests)).toHaveLength(0);
  });

  it("aborts writes for unreadable local notes or an incomplete remote listing", async () => {
    await obsidianPage.write("Unreadable.md", approved("public", "Temporarily unavailable"));
    await control({ seed: [legacy("orphan", "Missing.md", approved("public", "Searchable"))] });
    const local = await browser.executeObsidian(async ({ app, plugins }) => {
      const { adapter } = app.vault;
      const original = adapter.readBinary.bind(adapter);
      adapter.readBinary = (path) => path === "Unreadable.md" ? Promise.reject(new Error("EIO")) : original(path);
      try {
        await plugins.langdockSync.syncNow();
        return { issue: plugins.langdockSync.syncErrorText() };
      } finally {
        adapter.readBinary = original;
      }
    });
    expect(local.issue).toContain("Lokaler Bestand unvollständig");
    expect(mutations((await state()).requests)).toHaveLength(0);

    await control({ partial: true });
    expect((await syncNow()).issue).toContain("Langdock-Dateibestand unvollständig");
    const result = await state();
    expect(result.files.map(({ id }) => id)).toEqual(["orphan"]);
    expect(mutations(result.requests)).toHaveLength(0);
  });
});
