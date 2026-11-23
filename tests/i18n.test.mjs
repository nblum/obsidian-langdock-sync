import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readData } from "../src/config.ts";
import { createTranslator, formatIssue, languageNames, resolveLanguage } from "../src/i18n.ts";

const loadLocale = (locale) => JSON.parse(readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), "utf8"));
const placeholders = (text) => (text.match(/\{[\w.-]+\}/gu) ?? []).sort();

test("all locales provide the same messages with the same placeholders", () => {
  const base = loadLocale("en");
  for (const language of Object.keys(languageNames)) {
    const dictionary = loadLocale(language);
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(base).sort(), language);
    for (const [key, value] of Object.entries(dictionary)) {
      assert.ok(value.trim(), `${language}: ${key}`);
      assert.deepEqual(placeholders(value), placeholders(base[key]), `${language}: ${key}`);
    }
  }
});

test("uses the Obsidian locale with English fallback, including the Portuguese and Chinese variants", () => {
  for (const [locale, expected] of Object.entries({
    "de-DE": "de", "fr-CA": "fr", "es-419": "es", "it-IT": "it", "nl-NL": "nl", "pt": "pt-PT",
    "pt-BR": "pt-BR", "PT-pt-1990": "pt-PT", "zh": "zh-CN", "zh-Hans": "zh-CN", "zh-SG": "zh-CN",
    "zh-TW": "en", "zh-Hant": "en", "ja": "en",
  })) {
    assert.equal(resolveLanguage("auto", locale), expected, locale);
  }
  assert.equal(resolveLanguage("de", "zh-CN"), "de");
  assert.equal(resolveLanguage("zh-CN", "de"), "zh-CN");
});

test("formats a persisted error in the selected language and preserves legacy text", () => {
  const legacy = readData({ error: "Alter Fehler", language: "unsupported" });
  assert.equal(legacy.language, "auto");
  assert.deepEqual(legacy.status.issues, ["Alter Fehler"]);
  const issue = { key: "errors.indexFailed", variables: { status: "TIMEOUT" }, path: "Notiz.md" };
  const saved = readData({ language: "fr", issues: [issue, { key: "invalid", variables: {} }] });
  assert.equal(saved.language, "fr");
  assert.deepEqual(saved.status.issues, [issue]);
  assert.equal(formatIssue(createTranslator("de"), issue), "Notiz.md: Langdock konnte die Datei nicht indexieren (TIMEOUT).");
  assert.equal(formatIssue(createTranslator("en"), issue), "Notiz.md: Langdock could not index the file (TIMEOUT).");
  assert.equal(formatIssue(createTranslator("zh-CN"), issue), "Notiz.md：Langdock 无法为文件建立索引（TIMEOUT）。");
});
