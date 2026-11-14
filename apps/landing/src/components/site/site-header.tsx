import Link from "next/link"
import { Button } from "@/components/ui/button"
import { NAV_LINKS, SITE } from "@/lib/site"

export function SiteHeader() {
  return (
    <header className="relative z-10 border-b border-transparent">
      <div className="mx-auto flex min-h-16 max-w-[1120px] items-center justify-between gap-4 px-4 sm:px-6">
        <Link
          href="/"
          className="type-label -mx-1 rounded-sm px-1 py-2 text-foreground no-underline outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {SITE.name}
        </Link>
        <nav aria-label="Utama" className="hidden items-center gap-6 md:flex">
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="py-2 text-muted-foreground no-underline hover:text-foreground">
              {l.label}
            </Link>
          ))}
          {/* /docs and /dashboard are separate apps: plain links, not client-side routes. */}
          <a href={SITE.docsUrl} className="py-2 text-muted-foreground no-underline hover:text-foreground">
            Dokumentasi
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <Link
            href="/harga"
            className="py-2 text-muted-foreground no-underline hover:text-foreground md:hidden"
          >
            Harga
          </Link>
          <Button asChild variant="secondary">
            <a href={SITE.signInUrl}>Masuk</a>
          </Button>
        </div>
      </div>
    </header>
  )
}
