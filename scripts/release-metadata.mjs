import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const metadataFiles = ["manifest.json", "package.json", "package-lock.json", "versions.json"];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function requireVersion(value, label) {
  if (typeof value !== "string" || !versionPattern.test(value)) {
    throw new Error(`${label} must use x.y.z format without a prefix or leading zeroes.`);
  }
}

export function validateMetadata({ manifest, packageMetadata, lock, versions }, tag) {
  for (const field of ["id", "name", "description", "author"]) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) {
      throw new Error(`manifest.json must specify ${field}.`);
    }
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.id) || manifest.id.includes("obsidian")) {
    throw new Error("manifest.json has an invalid plugin ID.");
  }
  if (typeof manifest.isDesktopOnly !== "boolean") {
    throw new Error("manifest.json must specify a boolean isDesktopOnly.");
  }
  requireVersion(manifest.version, "Plugin version");
  requireVersion(manifest.minAppVersion, "Minimum Obsidian version");

  const rootPackage = lock.packages?.[""];
  if ([packageMetadata.version, lock.version, rootPackage?.version].some((version) => version !== manifest.version)) {
    throw new Error("The plugin version must match in manifest.json, package.json and package-lock.json.");
  }
  for (const [version, minimum] of Object.entries(versions)) {
    requireVersion(version, "versions.json plugin version");
    requireVersion(minimum, `Minimum Obsidian version for ${version}`);
  }
  if (versions[manifest.version] !== manifest.minAppVersion) {
    throw new Error("versions.json must map the current plugin version to manifest.json's minAppVersion.");
  }
  if (tag !== undefined && tag !== manifest.version) {
    throw new Error(`Tag ${tag} must match the plugin version ${manifest.version}.`);
  }
}

function findChangelogSection(changelog, version) {
  const headings = [...changelog.matchAll(/^## \[([^\]\r\n]+)\](?: - \d{4}-\d{2}-\d{2})?[ \t]*$/gm)];
  const index = headings.findIndex((heading) => heading[1] === version);
  if (index < 0) throw new Error(`CHANGELOG.md is missing the [${version}] section.`);

  const heading = headings[index];
  const start = heading.index + heading[0].length;
  const end = headings[index + 1]?.index ?? changelog.length;
  const notes = changelog.slice(start, end).trim();
  if (!notes) throw new Error(`CHANGELOG.md needs release notes under [${version}].`);
  return { start, end, notes };
}

export function prepareRelease(metadata, changelog, version, date) {
  validateMetadata(metadata);
  requireVersion(version, "Target version");
  const previous = metadata.manifest.version.split(".").map(BigInt);
  const next = version.split(".").map(BigInt);
  const difference = next.findIndex((part, index) => part !== previous[index]);
  if (difference < 0 || next[difference] < previous[difference] || Object.hasOwn(metadata.versions, version)) {
    throw new Error(`Target version must be newer than ${metadata.manifest.version} and absent from versions.json.`);
  }

  const { start, end, notes } = findChangelogSection(changelog, "Unreleased");
  const { manifest, packageMetadata, lock, versions } = metadata;
  const updated = {
    manifest: { ...manifest, version },
    packageMetadata: { ...packageMetadata, version },
    lock: { ...lock, version, packages: { ...lock.packages, "": { ...lock.packages[""], version } } },
    versions: { ...versions, [version]: manifest.minAppVersion },
  };
  validateMetadata(updated, version);
  const lineEnding = changelog.includes("\r\n") ? "\r\n" : "\n";
  const remaining = changelog.slice(end);
  const section = [changelog.slice(0, start), "", `## [${version}] - ${date}`, "", notes, ""].join(lineEnding);
  return { metadata: updated, changelog: remaining ? `${section}${lineEnding}${remaining}` : section };
}

function main([mode, version, ...extra]) {
  if (!["check", "prepare", "notes"].includes(mode) || extra.length || (mode !== "check" && !version)) {
    throw new Error("Usage: release-metadata.mjs check [tag] | prepare <version> | notes <version>");
  }

  const paths = [...metadataFiles, "CHANGELOG.md"].map((file) => new URL(`../${file}`, import.meta.url));
  const originals = paths.map((file) => readFileSync(file, "utf8"));
  const [manifest, packageMetadata, lock, versions] = originals.slice(0, 4).map((json) => JSON.parse(json));
  const metadata = { manifest, packageMetadata, lock, versions };
  const changelog = originals[4];
  if (mode === "check") {
    validateMetadata(metadata, version);
    console.log(`Release metadata is valid (${manifest.version}).`);
  } else if (mode === "notes") {
    validateMetadata(metadata, version);
    console.log(findChangelogSection(changelog, version).notes);
  } else {
    const release = prepareRelease(metadata, changelog, version, new Date().toISOString().slice(0, 10));
    const { manifest, packageMetadata, lock, versions } = release.metadata;
    const json = [manifest, packageMetadata, lock, versions].map((value) => `${JSON.stringify(value, null, 2)}\n`);
    const contents = [...json, release.changelog];
    const attempted = [];
    try {
      paths.forEach((file, index) => {
        attempted.push(index);
        writeFileSync(file, contents[index]);
      });
    } catch (error) {
      for (const index of attempted.reverse()) {
        try {
          writeFileSync(paths[index], originals[index]);
        } catch (rollbackError) {
          console.error(`Could not restore ${fileURLToPath(paths[index])}: ${rollbackError.message}`);
        }
      }
      throw error;
    }
    console.log(`Prepared ${version}. Review the changes and follow CONTRIBUTING.md to publish.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
