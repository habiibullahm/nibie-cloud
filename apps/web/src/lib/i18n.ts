import { ID } from "./i18n-id"
import { useLang, type Lang } from "./prefs"

export type Vars = Record<string, string | number>

/**
 * English is the source text and the key; ID maps it to Bahasa Indonesia. A missing entry falls back to English
 * (test/i18n.test.ts fails on any literal passed to t() without one). `{name}` placeholders are filled from `vars`.
 */
export function translate(lang: Lang, text: string, vars?: Vars): string {
  const s = lang === "id" ? (ID[text] ?? text) : text
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s
}

export type T = (text: string, vars?: Vars) => string

export function useT(): T {
  const lang = useLang()
  return (text, vars) => translate(lang, text, vars)
}
