import { Button } from "@/components/ui/button"
import { betaAccessHref, SITE } from "@/lib/site"

export function ClosingCta() {
  return (
    <section className="border-t border-border py-16">
      <div className="mx-auto grid max-w-[1120px] justify-items-start gap-4 px-4 sm:px-6">
        <h2 className="type-h2 max-w-[24ch]">Mulai jalankan agent Hermes-mu hari ini</h2>
        <p className="text-muted-foreground">{SITE.name} sedang beta undangan. Minta akses dan kami kabari saat slot tersedia.</p>
        <Button asChild>
          <a href={betaAccessHref("Minta akses beta Nibie Cloud")}>Minta akses beta</a>
        </Button>
      </div>
    </section>
  )
}
