import de from "../locales/de.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };
import es from "../locales/es.json" with { type: "json" };
import fr from "../locales/fr.json" with { type: "json" };
import it from "../locales/it.json" with { type: "json" };
import nl from "../locales/nl.json" with { type: "json" };
import ptBR from "../locales/pt-BR.json" with { type: "json" };
import ptPT from "../locales/pt-PT.json" with { type: "json" };
import zhCN from "../locales/zh-CN.json" with { type: "json" };

export type TranslationKey = keyof typeof en;
type Variables = Readonly<Record<string, string | number>>;
export type Translator = (key: TranslationKey, variables?: Variables) => string;

const translations = {
  en, de, es, fr, it, nl, "pt-BR": ptBR, "pt-PT": ptPT, "zh-CN": zhCN,
} satisfies Record<string, Record<TranslationKey, string>>;

export type Language = keyof typeof translations;
export type LanguagePreference = "auto" | Language;

export const languageNames: Record<Language, string> = {
  de: "Deutsch",
  en: "English",
  fr: "Français",
  it: "Italiano",
  es: "Español",
  "pt-BR": "Português (Brasil)",
  "pt-PT": "Português (Portugal)",
  nl: "Nederlands",
  "zh-CN": "简体中文",
};

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return typeof value === "string" && (value === "auto" || Object.hasOwn(translations, value));
}

export function resolveLanguage(preference: LanguagePreference, locale: string): Language {
  if (preference !== "auto") return preference;
  const detected = locale.toLowerCase();
  const base = detected.split("-")[0];
  if (base === "pt") return detected === "pt" || /^pt-pt(?:-|$)/u.test(detected) ? "pt-PT" : "pt-BR";
  if (/^zh(?:$|-(?:cn|sg|hans)(?:-|$))/u.test(detected)) return "zh-CN";
  return isLanguagePreference(base) && base !== "auto" ? base : "en";
}

export function createTranslator(language: Language): Translator {
  return (key, variables = {}) => (translations[language][key] ?? en[key]).replace(
    /\{([a-zA-Z0-9_.-]+)\}/gu,
    (placeholder, name: string) => variables[name] === undefined ? placeholder : String(variables[name]),
  );
}

export type ErrorKey = Extract<TranslationKey, `errors.${string}`>;

export interface Issue {
  key: ErrorKey;
  variables?: Variables;
  path?: string;
}

export function isStoredIssue(value: unknown): value is Issue | string {
  if (typeof value === "string") return true;
  if (typeof value !== "object" || value === null) return false;
  const { key, variables, path } = value as Record<string, unknown>;
  return typeof key === "string" && key.startsWith("errors.") && Object.hasOwn(en, key)
    && (path === undefined || typeof path === "string")
    && (variables === undefined || (typeof variables === "object" && variables !== null && !Array.isArray(variables)
      && Object.values(variables).every((item) => typeof item === "string" || typeof item === "number")));
}

const english = createTranslator("en");

export class LocalizedError extends Error {
  readonly issue: Issue;

  constructor(key: ErrorKey, variables?: Variables) {
    super(english(key, variables));
    this.issue = { key, ...(variables && { variables }) };
  }
}

export function issueFromError(error: unknown): Issue {
  return error instanceof LocalizedError ? error.issue : { key: "errors.generic" };
}

export function formatIssue(translate: Translator, issue: Issue | string): string {
  if (typeof issue === "string") return issue;
  const message = translate(issue.key, issue.variables);
  return issue.path === undefined ? message : translate("errors.note", { path: issue.path, message });
}
