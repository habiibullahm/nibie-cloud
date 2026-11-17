import { Button } from "@/components/ui/button"
import { ctaHref, freeBetaOpen, signupOpen, SITE } from "@/lib/site"
import { FreeBetaCta } from "@/components/site/free-beta"

export function ClosingCta() {
  const open = signupOpen()
  const freeBeta = freeBetaOpen() && !open
  return (
    <section className="border-t border-border py-16">
      <div className="mx-auto grid max-w-[1120px] justify-items-start gap-4 px-4 sm:px-6">
        <h2 className="type-h2 max-w-[24ch]">Mulai jalankan agent Hermes-mu hari ini</h2>
        <p className="text-muted-foreground">
          {open
            ? `${SITE.name} sedang beta. Daftar, pilih paket, bayar, dan instance-mu aktif setelah pembayaran terverifikasi.`
            : (freeBeta
              ? `${SITE.name} sedang beta preview gratis dengan slot terbatas. Daftar sekarang, siapa cepat dia dapat; kalau slot habis kamu bisa masuk daftar tunggu.`
              : `${SITE.name} sedang beta preview gratis dengan slot terbatas. Minta akses dan kami kabari lewat email saat slotmu siap.`)}
        </p>
        {freeBeta ? (
          <div className="flex flex-wrap gap-3">
            <FreeBetaCta />
          </div>
        ) : (
          <Button asChild>
            <a href={ctaHref("Minta akses beta Nibie Cloud", open)}>{open ? "Daftar dan pilih paket" : "Minta akses beta"}</a>
          </Button>
        )}
      </div>
    </section>
  )
}
