/** Preference constants without React, so the server root layout can import them (lib/prefs.ts holds the hooks). */
export type Theme = "dark" | "light"
export type Lang = "id" | "en"

export const THEME_KEY = "nibie.theme"
export const LANG_KEY = "nibie.lang"
/** Dark stays the default (DESIGN.md is dark-first); Bahasa Indonesia is the default language. */
export const DEFAULT_THEME: Theme = "dark"
export const DEFAULT_LANG: Lang = "id"

/** Inline in <head> (the CSP allows inline scripts). Mirrors parseTheme/parseLang below. */
export const PREFS_SCRIPT = `try{var d=document.documentElement;d.dataset.theme=localStorage.getItem("${THEME_KEY}")==="light"?"light":"dark";d.lang=localStorage.getItem("${LANG_KEY}")==="en"?"en":"id"}catch(e){}`

export function parseTheme(v: string | null | undefined): Theme {
  return v === "light" ? "light" : "dark"
}
export function parseLang(v: string | null | undefined): Lang {
  return v === "en" ? "en" : "id"
}
