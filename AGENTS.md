# Langdock Sync Agent Instructions

- Before working on the plugin, read the [shared plugin rules](CONTRIBUTING.md#shared-plugin-rules) through the local `.obsidian-plugin-rules` reference. Ask the user for the note's location if the reference is missing or the note is inaccessible.
- Read [README.md](README.md) for project status and [CONTRIBUTING.md](CONTRIBUTING.md) for development and release commands.
- Read [implement-langdock-sync](agent-skills/implement-langdock-sync/SKILL.md) for plugin changes and [release-langdock-sync](agent-skills/release-langdock-sync/SKILL.md) for release work.
- Keep plugin code in `src/` and use `src/main.ts` as the entry point. Keep generated `main.js` and local plugin data out of Git.
- Run lint, tests, and the build for plugin changes. Use the fixture vault in `tests/e2e/vault/` for automated Obsidian tests.
- Write development documentation in English. Record user-visible changes under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
