"use client"

import Link from "next/link"
import { useEffect, useId, useRef, useState } from "react"
import { Menu, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { NAV_LINKS, SITE } from "@/lib/site"

const linkClass =
  "flex min-h-11 items-center rounded-sm px-2 text-foreground no-underline outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"

/**
 * Phone navigation: a plain disclosure (button with aria-expanded) that lists the same destinations as the desktop nav.
 * Escape and a tap outside close it; choosing a link closes it too, so a same-page anchor does not leave it open.
 */
export function MobileMenu() {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return
      setOpen(false)
      buttonRef.current?.focus()
    }
    function onPointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("pointerdown", onPointer)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("pointerdown", onPointer)
    }
  }, [open])

  const close = () => setOpen(false)

  return (
    <div ref={rootRef} className="md:hidden">
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <X aria-hidden /> : <Menu aria-hidden />}
        Menu
      </Button>
      <nav id={panelId} aria-label="Menu utama" hidden={!open} className="absolute inset-x-0 top-full border-y border-border bg-background">
        <ul className="mx-auto grid max-w-[1120px] gap-1 px-2 py-2 sm:px-4">
          {NAV_LINKS.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className={linkClass} onClick={close}>
                {l.label}
              </Link>
            </li>
          ))}
          <li>
            {/* /docs is a separate app: a plain link, not a client-side route. */}
            <a href={SITE.docsUrl} className={linkClass} onClick={close}>
              Dokumentasi
            </a>
          </li>
        </ul>
      </nav>
    </div>
  )
}
