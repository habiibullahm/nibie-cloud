import Link from "next/link"
import { LEGAL_LINKS, SITE, contactEmail } from "@/lib/site"

export function SiteFooter() {
  const email = contactEmail()
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto max-w-[1120px] px-4 py-12 sm:px-6">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="grid content-start gap-3">
            <span className="type-label">{SITE.name}</span>
            <p className="max-w-[36ch] text-muted-foreground">
              Hosting terkelola untuk agent AI Hermes, oleh Nibie ({SITE.operator}). Satu container terisolasi untuk
              setiap pelanggan.
            </p>
          </div>
          <FooterColumn title="Produk">
            <Link href="/#fitur">Fitur</Link>
            <Link href="/harga">Harga</Link>
            <a href={SITE.docsUrl}>Dokumentasi</a>
            <a href={SITE.signInUrl}>Masuk</a>
          </FooterColumn>
          <FooterColumn title="Legal">
            {LEGAL_LINKS.map((l) => (
              <Link key={l.href} href={l.href}>
                {l.label}
              </Link>
            ))}
          </FooterColumn>
          <FooterColumn title="Kontak">
            {email ? <a href={`mailto:${email}`}>{email}</a> : null}
            <Link href="/kontak">Halaman kontak</Link>
          </FooterColumn>
        </div>
        <div className="mt-10 flex flex-wrap justify-between gap-3 border-t border-border pt-4 text-[0.8125rem] text-muted-foreground">
          <span>© 2026 {SITE.operator}. Seluruh harga dalam Rupiah (IDR).</span>
        </div>
      </div>
    </footer>
  )
}

function FooterColumn({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="type-label mb-3 text-muted-foreground">{title}</h2>
      {/* On touch each link is at least 44x44px (the gap folds into the taller rows); every link gets the button focus ring. */}
      <div className="grid gap-2 pointer-coarse:gap-0 [&_a]:hit-area [&_a]:relative [&_a]:-mx-1 [&_a]:inline-flex [&_a]:px-1 [&_a]:w-fit [&_a]:items-center [&_a]:rounded-sm [&_a]:text-foreground [&_a]:no-underline [&_a]:outline-none [&_a]:hover:underline [&_a]:focus-visible:ring-2 [&_a]:focus-visible:ring-ring [&_a]:pointer-coarse:min-h-11">
        {children}
      </div>
    </div>
  )
}
