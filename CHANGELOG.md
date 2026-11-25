# Changelog

## [Unreleased]

## [0.3.1] - 2026-11-25

### Changed

- Start the introduction with a welcome page and open the Langdock Sync settings when you select **Done**.
- Illustrate each introduction step with an Obsidian screenshot.

## [0.3.0] - 2026-11-24

### Added

- Assign Langdock knowledge bases by vault folder. Subfolders use the nearest assignment, and an assignment for `/` provides the vault-wide default. Existing folder selections keep their previous knowledge base after upgrading. The preview groups changes by knowledge base.
- Select attachment extensions from a checklist and sync files whose entry in the folder’s `_meta.md` matches the sync filters.
- Show a sync status button by default in the header of eligible notes and attachments, next to the Classificator badge when present. Open it to see when the indexed copy was uploaded and to sync the file.
- Explain how to grant the workspace API key Editor access beside **Load knowledge bases** and in the setup guide.
- Remember the names of assigned knowledge bases so they are visible in settings after a restart and when offline.

### Changed

- Configure periodic sync independently of **Sync automatically**, which controls sync on startup and after vault changes. A previously selected interval now runs even when **Sync automatically** is off.

## [0.2.0] - 2026-11-23

### Added

- Offer an optional sync interval that checks for changes while the vault is open, even without vault events.

### Documentation

- Refresh the connection, filters, sync status, and About screenshots for 0.1.1.
- Rewrite the README with quick links, installation from Community plugins, a first-sync walkthrough, and troubleshooting.
- Disclose that Langdock Sync uses the Langdock Knowledge Folder API (`api.langdock.com`) to compare notes, check indexing status, and sync the full Markdown content of eligible notes, including their YAML properties.

## [0.1.1] - 2026-11-23

### Fixed

- Make Langdock Sync controls discoverable in Obsidian settings search on 1.13.0 and later.
- Use native settings headings and clean up the plugin description and status styles for the Community Directory review.
- Keep waiting for Langdock to finish indexing if the settings pop-out closes.
- Explain which setup step is needed when Preview and Sync now are disabled.
- Open the preview dialog immediately and show progress while preparing the sync plan.

## [0.1.0]

### Added

- Sync locally saved Markdown notes classified as public or internal with a selected Langdock knowledge base.
- Save the API key in Obsidian SecretStorage under the fixed ID `langdock-api` in the connection section and preview uploads, updates, and removals.
- Resume pending uploads and recover offline edits without duplicating compatible Python-script uploads.
- Require at least one vault folder and support optional YAML property filters, defaulting to `classification: public`. The filter help explains the OR and AND rules with an example.
- Keep automatic sync off at first launch and document the switch from the GitHub workflow.
- Show connection and sync messages in color-coded status panels.
- Translate the plugin UI, commands, preview and status messages into nine languages. Follow the Obsidian language by default and allow an override.
- Add a guided introduction on first use and an About dialog. Show plugin details at the top of settings, followed by the language picker and both dialog buttons. The command palette can also open either dialog.
- Link to the Langdock workspace API settings and show the required Knowledge Folder API permission next to the API key field.
- Add an opt-in screenshot suite and gallery for refreshing the documentation images.
- Add a Langdock Sync teaser with an example of a classified note synced to a knowledge base.
- Require Obsidian 1.12.4 for SecretStorage, including its Linux keychain fixes.
