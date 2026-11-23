---
name: implement-langdock-sync
description: Implement features and fix sync behavior, Obsidian settings, dialogs, or translations in the Langdock Sync plugin.
---

# Implement Langdock Sync

Read [README.md](../../README.md) and [CONTRIBUTING.md](../../CONTRIBUTING.md). Trace the change through `src/main.ts` and the affected module.

- Keep note eligibility tied to the exact bytes uploaded. Classificator manages the shared `classification` property. Langdock Sync reads it and applies the folder allowlist, property filters, and explicit opt-out.
- Preserve Python upload adoption, serial reconciliation, and the `SYNCED` check before deleting the old version. A partial inventory must stop the run before remote writes. Keep manual uploads outside managed reconciliation.
- Keep the API key under the fixed `langdock-api` SecretStorage entry. For UI changes, update all dictionaries in `locales/` while preserving IDs and saved values.
- Exercise affected vault events and UI through the Obsidian fixture suite and local Langdock mock. For documentation captures, use the separate screenshot commands. Record user-visible changes under `[Unreleased]`.
