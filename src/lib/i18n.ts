// UI language. Source strings are the English text itself: `tr("Save")`, and for text
// with values `tr("Exit code {0}", { 0: code })` (placeholders only replaced when values
// are passed, so a literal "{{name}}" stays as is). A string with no translation shows in
// English. Switching language re-mounts the UI (see App), so plain calls during render are
// enough — no hooks needed.
import { zh } from "./i18n-zh";

export type Lang = "en" | "zh";
/** Settings value: follow the OS, or a fixed language. */
export type LangSetting = "system" | Lang;

export const LANGUAGES: { value: LangSetting; label: string }[] = [
  { value: "system", label: "System" },
  { value: "en", label: "English" },
  { value: "zh", label: "简体中文" },
];

// Kept on globalThis so a hot-reloaded copy of this module shares it.
const g = globalThis as { __rtLang?: Lang };
g.__rtLang ??= systemLang();
document.documentElement.lang = g.__rtLang === "zh" ? "zh-CN" : "en";

export function systemLang(): Lang {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  return /^zh\b/i.test(langs[0] ?? "") ? "zh" : "en";
}

export const resolveLang = (s: LangSetting | undefined): Lang => (!s || s === "system" ? systemLang() : s);

export function lang(): Lang {
  return g.__rtLang ?? "en";
}

/** Returns true when the language actually changed. */
export function setLang(l: Lang): boolean {
  if (l === g.__rtLang) return false;
  g.__rtLang = l;
  document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
  return true;
}

export function tr(s: string, vars?: Record<string, string | number | null | undefined>): string {
  let out = g.__rtLang === "zh" ? (zh[s] ?? s) : s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? "") : m));
  return out;
}

/** "1 session" / "3 sessions" in English; Chinese has no plural forms. */
export function plural(n: number, one: string, many: string) {
  return tr(n === 1 ? one : many, { n });
}
