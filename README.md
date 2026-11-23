# Langdock Sync

[![CI](https://github.com/nblum/obsidian-langdock-sync/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nblum/obsidian-langdock-sync/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/nblum/obsidian-langdock-sync?label=release)](https://github.com/nblum/obsidian-langdock-sync/releases/latest)
[![MIT license](https://img.shields.io/github/license/nblum/obsidian-langdock-sync)](LICENSE)
[![Star on GitHub](https://img.shields.io/github/stars/nblum/obsidian-langdock-sync?logo=github&label=star)](https://github.com/nblum/obsidian-langdock-sync)
[![Buy me a coffee](https://img.shields.io/badge/Buy_me_a_coffee-Ko--fi-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/blumnico)

Send selected Markdown notes from Obsidian to a Langdock knowledge base. Choose which notes to include, preview what will change, and sync manually or automatically.

Requires **Obsidian 1.12.4 or later** on desktop or mobile.

[Obsidian plugin directory](https://community.obsidian.md/plugins/langdock-sync) · [Get started](#get-started) · [Filters and exclusions](#adjust-what-you-share) · [Troubleshooting](#troubleshooting)

![Sync preview showing a new Launch notes upload, a Support guide update, and removal of an older FAQ copy](assets/screenshots/preview.webp)

## Get started

### Install in Obsidian

1. In Obsidian, open **Settings → Community plugins**. Select **Turn on community plugins** if prompted.
2. Select **Browse**, search for **Langdock Sync**, then select **Install** and **Enable**.

### Connect to Langdock

1. Ask your Langdock workspace admin to create a workspace API key with the **Knowledge Folder API** permission (`KNOWLEDGE_FOLDER_API`). In the knowledge base’s **Share** dialog, the admin grants the key the **Editor** role. [Langdock setup guide](https://docs.langdock.com/en/developer/knowledge-folder-api/sharing)
2. In Obsidian, open **Settings → Langdock Sync**, paste the key, and select **Save key**.
3. Choose your **Knowledge base**, then select **Test connection**. Use **Load knowledge bases** to refresh the list if needed.

![Langdock connection settings with Product handbook selected and a Connection successful message](assets/screenshots/connection.webp)

### Choose notes to sync

Under **Manage folders**, select **Add folder** and choose a vault folder, such as `Knowledge`. Subfolders are included. Choose **Entire vault (/)** to apply your filters across the vault.

The default filter includes notes with the property `classification: public`. To try it, create `Knowledge/Launch notes.md` and paste this example in Obsidian’s **Source mode**. If the note already has Properties, add the fields to that section.

```markdown
---
classification: public
audience: team
---

# Launch notes

The new help center is available to all customers.
```

Langdock receives the full Markdown file, including its Properties. The two valid classifications are `public` and `internal`. Each synced note needs a single classification, even if you remove all property filters.

![Manage folders and Manage properties with the Knowledge folder and the default public classification filter](assets/screenshots/filters.webp)

### Preview and run your first sync

1. In **Settings → Langdock Sync**, select **Preview** to review planned uploads, updates, and deletions in Langdock.
2. Close the preview, select **Sync now**, and check **Last successful sync** in the settings. The example note will appear in your selected Langdock knowledge base.
3. To keep it up to date, turn on **Sync automatically**. This starts off disabled. Once enabled, it runs when you open the vault and after changes in it.
4. To sync periodically while the vault is open, choose a **Sync interval** of 15 minutes, 30 minutes, 1 hour, or 2 hours. It starts off disabled and requires **Sync automatically**.

![Sync settings showing the Preview and Sync now buttons and the time of the last successful sync](assets/screenshots/sync-status.webp)

## Adjust what you share

- **Filter by more properties.** Under **Manage properties**, add `classification = internal` and `audience = team` alongside the default `classification = public` to include both public and internal notes for the team. Values for the same property are alternatives. Each different property must match. A list property matches when any item has an allowed value.
- **Exclude a note.** Set `langdock_sync: false` in its Properties. The next sync removes the managed copy from Langdock. Deleting a local note or changing the folder or filters so it no longer qualifies also removes its managed copy. Files you uploaded separately remain in Langdock.
- **Use one source vault per knowledge base.** The plugin removes managed copies that fall outside the current vault’s sync selection.

## Troubleshooting

- **The knowledge base is missing or read-only.** Ask your workspace admin to check the key’s **Editor** access to that knowledge base. Then select **Load knowledge bases** again. [Langdock sharing guide](https://docs.langdock.com/en/developer/knowledge-folder-api/sharing)
- **A note is missing from the preview.** Check its folder, classification, and any extra filters. The preview lists changes, so an unchanged note that's already in Langdock may be absent.
- **Langdock reports an indexing error.** Check the message in **Settings → Langdock Sync** and select **Sync now** to retry.

[Report an issue](https://github.com/nblum/obsidian-langdock-sync/issues) · [Release notes](CHANGELOG.md) · [Local build and contributor guide](CONTRIBUTING.md#development)
