import { describe, expect, it } from "vitest"
import { PREFS_SCRIPT } from "../src/lib/prefs-core"

/** Runs the inline <head> script against a fake document and localStorage. */
function run(stored: Record<string, string>, storageThrows = false) {
  const html = { dataset: {} as Record<string, string>, lang: "id" }
  const localStorage = {
    getItem: (k: string) => {
      if (storageThrows) throw new Error("blocked")
      return stored[k] ?? null
    },
  }
  new Function("document", "localStorage", PREFS_SCRIPT)({ documentElement: html }, localStorage)
  return { theme: html.dataset.theme, lang: html.lang }
}

describe("PREFS_SCRIPT", () => {
  it("applies the saved theme and language", () => {
    expect(run({ "nibie.theme": "light", "nibie.lang": "en" })).toEqual({ theme: "light", lang: "en" })
  })
  it("falls back to dark and Bahasa Indonesia for missing or unknown values", () => {
    expect(run({})).toEqual({ theme: "dark", lang: "id" })
    expect(run({ "nibie.theme": "<x>", "nibie.lang": "fr" })).toEqual({ theme: "dark", lang: "id" })
  })
  it("never throws when storage is blocked", () => {
    expect(() => run({}, true)).not.toThrow()
  })
})
