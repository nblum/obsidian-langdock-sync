# Contributing to Langdock Sync

## Shared plugin rules

Read the shared Obsidian plugin checklist before working on the plugin. Store the absolute path to the rules note on one line in `.obsidian-plugin-rules` at the repository root. Git ignores this local file. If the reference is missing or the note is inaccessible, ask the user for the note's location.

Add rules that apply across Obsidian plugins to the shared note. Document Langdock Sync-specific practices in this repository.

## Development

Use the Node.js version pinned in `.nvmrc` (`nvm install` or `nvm use`) and install the locked dependencies with `npm ci`. CI and the release workflow read the same version file.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Rebuild `main.js` on source changes with inline source maps. |
| `npm run lint` | Check JavaScript and TypeScript with ESLint and apply Obsidian's recommended rules to the plugin source. |
| `npm test` | Run the fast Node.js tests. |
| `npm run build` | Validate release metadata, check types, and build the production bundle. |
| `npm run test:e2e` | Build the plugin and run the desktop integration suite against a local Langdock mock. |

Run lint, tests, and the build before submitting a change. The desktop suite opens a temporary copy of the fixture vault. The runner starts a loopback HTTP mock and builds a temporary copy of the plugin that directs Obsidian’s `requestUrl` calls to that mock. The production bundle uses Langdock’s public API URL. On Linux, install Xvfb, Openbox, xauth, and the Electron libraries listed in [CI](.github/workflows/ci.yml). The runner uses a private display by default. Set `E2E_HEADED=1` for a visible debugging session on Linux.

The suite reads the minimum Obsidian version from the manifest. Set `OBSIDIAN_VERSION=latest` to run against the current public build. CI runs both. On Linux, Electron uses the basic password store in the temporary test profile for the simulated API key. Downloads are cached in `.obsidian-cache/` and test logs and failure screenshots go to `e2e-results/`.

## Project layout

- `src/main.ts` manages the plugin lifecycle and serial queue. `src/notes.ts` reads and classifies the vault inventory, `src/langdock.ts` implements the API client, and `src/sync.ts` plans and applies changes.
- `manifest.json`, `versions.json`, and `styles.css` hold Obsidian metadata and plugin styles. The build generates `main.js`.
- `tests/` contains Node.js tests and `tests/e2e/` contains the Obsidian suite and its fixture vault.
- `scripts/` contains local test and release tooling. `.github/workflows/` contains the CI and release workflows.
- `agent-skills/` contains the project skills listed in [AGENTS.md](AGENTS.md).

## Documentation screenshots

Run `npm run screenshots` for a preview gallery in `e2e-results/screenshots/index.html`. Run `npm run screenshots:update` to capture and validate all registered images before replacing the documentation assets in `assets/screenshots/`.

The capture suite defaults to Obsidian 1.15.1 with a 1280 × 900 viewport, the light theme, English UI, and a fixed sample sync time in UTC. It uses a dedicated fixture vault and the same local Langdock mock as the integration tests. Set `OBSIDIAN_VERSION` to check a different Obsidian version or `E2E_HEADED=1` to watch the captures on Linux. The regular test suite and CI leave the documentation images untouched.

To add a capture, register its filename and caption in `tests/e2e/screenshot-assets.json` and capture the corresponding UI state in `tests/e2e/documentation.capture.ts`.

The introduction embeds its screenshots in `main.js`. Rebuild the plugin after changing these assets.

## Teaser artwork

The shared checklist defines the teaser layout and visual identity. Keep the 4:3 vector artwork in `assets/teaser/teaser.svg` with all lettering converted to paths. Export the same artwork as `teaser.png` at 480 × 360, `teaser@2x.png` at 960 × 720, and `teaser@3x.png` at 1440 × 1080. Check the legibility of the 480 × 360 image at actual size.

## Translations

Add visible strings to every JSON dictionary in `locales/`. Keep message keys and placeholders aligned across languages. Use structured issue keys for sync and API errors so the settings can translate saved status messages after a language change.

## Releases

Read the full [shared plugin checklist](#shared-plugin-rules) for each release. Complete the applicable pre-release requirements before publishing and perform the checklist's post-release checks afterward.

1. Record user-visible changes under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
2. Run `npm run release:prepare -- <version>` to update the manifest, package files, compatibility map, and changelog for each new version. The initial `0.1.0` already has its metadata and changelog section. If the minimum Obsidian version changes, update the manifest, the new version's entry in `versions.json`, and the CI matrix.
3. Run `node scripts/release-metadata.mjs notes <version>` and review the notes and compatibility map. Commit the version files and wait for CI to pass on the release commit on `main`.
4. Create an annotated tag with the exact manifest version, for example `0.1.0`. Pushing the tag runs the release workflow, which validates the metadata and publishes `main.js`, `manifest.json`, and `styles.css` with the matching changelog notes. Verify the notes, all three attachments, and the build attestations for the public repository. [Obsidian release documentation](https://docs.obsidian.md/plugins/releasing/submit-plugin)
