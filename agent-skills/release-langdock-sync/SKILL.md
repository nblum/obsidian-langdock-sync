---
name: release-langdock-sync
description: Prepare and validate Langdock Sync version metadata and notes, or publish an authorized GitHub release through the Obsidian tag workflow.
---

# Release Langdock Sync

Read the [shared plugin rules](../../CONTRIBUTING.md#shared-plugin-rules) through `.obsidian-plugin-rules` at the repository root. Ask the user for the note's location if the reference is missing or the note is inaccessible. Review the entire checklist during release preparation and confirm all applicable pre-release requirements are met before publishing.

Read the release section in [CONTRIBUTING.md](../../CONTRIBUTING.md). Check the manifest version, changelog, working tree, and existing remote tags before preparing a release.

- Use `npm run release:prepare -- <version>` for a newer version. It promotes the Unreleased notes and synchronizes the version files while keeping older compatibility entries. For an already prepared version, inspect its existing notes.
- Run `node scripts/release-metadata.mjs notes <version>` with the literal prospective tag and run the local validation commands. Review the release section against the changes included in the build.
- For an authorized publication, wait for successful CI on the release commit on `main`. Create and push the annotated tag named exactly `x.y.z`.
- Verify the tag workflow, release notes, and attached `main.js`, `manifest.json`, and `styles.css`. Check the provenance attestations for public releases and complete the applicable post-release checks from the shared checklist.
