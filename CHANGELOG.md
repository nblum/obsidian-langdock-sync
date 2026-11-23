# Changelog

## [Unreleased]

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
- Require Obsidian 1.12.4 for SecretStorage, including its Linux keychain fixes.
