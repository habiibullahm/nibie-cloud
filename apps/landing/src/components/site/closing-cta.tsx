import { Button } from "@/components/ui/button"
import { ctaHref, signupOpen, SITE } from "@/lib/site"

export function ClosingCta() {
  const open = signupOpen()
  return (
    <section className="border-t border-border py-16">
      <div className="mx-auto grid max-w-[1120px] justify-items-start gap-4 px-4 sm:px-6">
        <h2 className="type-h2 max-w-[24ch]">Mulai jalankan agent Hermes-mu hari ini</h2>
        <p className="text-muted-foreground">
          {open
            ? `${SITE.name} sedang beta. Daftar, pilih paket, bayar, dan instance-mu aktif setelah pembayaran terverifikasi.`
            : `${SITE.name} sedang beta undangan. Minta akses dan kami kabari saat slot tersedia.`}
        </p>
        <Button asChild>
          <a href={ctaHref("Minta akses beta Nibie Cloud", open)}>{open ? "Daftar dan pilih paket" : "Minta akses beta"}</a>
        </Button>
      </div>
    </section>
  )
}
