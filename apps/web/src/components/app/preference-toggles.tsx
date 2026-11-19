"use client"

import { Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n"
import { setLang, setTheme, useLang, useTheme, type Lang } from "@/lib/prefs"
import { cn } from "@/lib/utils"

const LANGS: { value: Lang; short: string; name: string }[] = [
  { value: "id", short: "ID", name: "Bahasa Indonesia" },
  { value: "en", short: "EN", name: "English" },
]

/** Theme and language switches. Used in the navigation rail and on the Account page. */
export function PreferenceToggles({ className }: { className?: string }) {
  const t = useT()
  const theme = useTheme()
  const lang = useLang()
  const dark = theme === "dark"
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div role="group" aria-label={t("Language")} className="flex rounded-sm border border-input p-0.5">
        {LANGS.map((l) => (
          <button
            key={l.value}
            type="button"
            lang={l.value}
            aria-label={`${l.short}, ${l.name}`}
            aria-pressed={lang === l.value}
            onClick={() => setLang(l.value)}
            className={cn(
              "hit-area relative rounded-xs px-2 py-1 type-label text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              lang === l.value && "bg-secondary text-foreground"
            )}
          >
            {l.short}
          </button>
        ))}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={dark ? t("Switch to light theme") : t("Switch to dark theme")}
        onClick={() => setTheme(dark ? "light" : "dark")}
      >
        {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      </Button>
    </div>
  )
}
