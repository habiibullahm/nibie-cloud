import { useSyncExternalStore } from "react"
import { DEFAULT_LANG, DEFAULT_THEME, LANG_KEY, THEME_KEY, parseLang, parseTheme, type Lang, type Theme } from "./prefs-core"

export type { Lang, Theme } from "./prefs-core"

/**
 * Viewer preferences: theme and language. The <html> element is the source of truth (`data-theme`, `lang`), set
 * before first paint by PREFS_SCRIPT from localStorage, so a reload never flashes the other theme. Per-browser
 * convenience only: nothing is sent to the backend.
 */
const listeners = new Set<() => void>()
function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private mode or blocked storage: the choice still applies until the page is reloaded.
  }
  listeners.forEach((fn) => fn())
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => parseTheme(document.documentElement.dataset.theme), () => DEFAULT_THEME)
}
export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
  save(THEME_KEY, theme)
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, () => parseLang(document.documentElement.lang), () => DEFAULT_LANG)
}
export function setLang(lang: Lang) {
  document.documentElement.lang = lang
  save(LANG_KEY, lang)
}
