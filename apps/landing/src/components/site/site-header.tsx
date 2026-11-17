import Image from "next/image"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { MobileMenu } from "@/components/site/mobile-menu"
import { NAV_LINKS, SITE } from "@/lib/site"

// Text links: at least 44px tall, 44px wide on touch (hit-area), and the same focus ring as the buttons.
const navLinkClass =
  "hit-area relative -mx-1 inline-flex min-h-11 items-center rounded-sm px-1 text-muted-foreground no-underline outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"

export function SiteHeader() {
  return (
    <header className="relative z-10 border-b border-transparent">
      <div className="mx-auto flex min-h-16 max-w-[1120px] items-center justify-between gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="type-label -mx-1 inline-flex min-h-11 items-center gap-2 rounded-sm px-1 text-foreground no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* Brand mark (owner-supplied asset); decorative, the name next to it is the link text. */}
          <Image src="/logo-mark-on-dark.png" alt="" aria-hidden width={36} height={24} loading="eager" className="h-6 w-9 shrink-0" />
          {SITE.name}
        </Link>
        <nav aria-label="Utama" className="hidden items-center gap-6 md:flex">
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className={navLinkClass}>
              {l.label}
            </Link>
          ))}
          {/* /docs and /dashboard are separate apps: plain links, not client-side routes. */}
          <a href={SITE.docsUrl} className={navLinkClass}>
            Dokumentasi
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <MobileMenu />
          <Button asChild variant="secondary">
            <a href={SITE.signInUrl}>Masuk</a>
          </Button>
        </div>
      </div>
    </header>
  )
}
