import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ctaHref, signupOpen, SITE } from "@/lib/site"

export function Hero() {
  const open = signupOpen()
  return (
    <section className="relative overflow-hidden">
      <div aria-hidden className="hero-grid-bg pointer-events-none absolute inset-x-0 top-0 h-[760px]" />
      <div className="relative mx-auto grid max-w-[1120px] items-center gap-12 px-4 pt-12 pb-16 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:pb-20">
        <div className="min-w-0">
          <Badge className="hc-rise">
            <span aria-hidden className="size-1.5 rounded-full bg-foreground" />
            {open ? "Beta terbuka" : "Beta undangan"}
          </Badge>
          <h1 className="type-display hc-rise hc-rise-1 mt-4">Agent <span className="whitespace-nowrap">Hermes-mu</span> aktif 24 jam, tanpa kamu mengurus server.</h1>
          <p className="type-lead hc-rise hc-rise-2 mt-6 max-w-[52ch] text-muted-foreground">
            {SITE.name} menjalankan satu container terisolasi dan satu volume penyimpanan khusus untuk setiap
            pelanggan. Kamu tinggal deploy, hubungkan platform pesanmu (saat ini Telegram), dan pakai. Tanpa VPS, tanpa Docker, tanpa perawatan.
          </p>
          <div className="hc-rise hc-rise-3 mt-8 flex flex-wrap gap-3">
            <Button asChild>
              <a href={ctaHref("Minta akses beta Nibie Cloud", open)}>{open ? "Daftar dan pilih paket" : "Minta akses beta"}</a>
            </Button>
            <Button asChild variant="outline">
              <a href={SITE.docsUrl}>Baca dokumentasi</a>
            </Button>
          </div>
          <ul className="hc-rise hc-rise-4 mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[0.8125rem] text-muted-foreground">
            <li>1 container per pelanggan</li>
            <li>Shell penuh di dalam container</li>
            <li>Tanpa akses ke server host</li>
          </ul>
        </div>
        <InstancePanel />
      </div>
    </section>
  )
}

/** Illustration only: static example values, labelled as such. */
function InstancePanel() {
  const rows: [string, string][] = [
    ["Nama", "agent-pribadi"],
    ["Isolasi", "container + volume sendiri"],
    ["Provider AI", "NibieRouter"],
    ["Platform", "Telegram"],
  ]
  return (
    <aside aria-label="Contoh tampilan dashboard" className="hc-rise hc-rise-panel rounded-md border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <span className="type-label text-muted-foreground">Instance</span>
        <Badge variant="outline">
          <span aria-hidden className="hc-pulse size-1.5 rounded-full bg-foreground" />
          Aktif
        </Badge>
      </div>
      <dl className="grid gap-3 p-4">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 border-b pb-3">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="type-mono min-w-0 text-right break-words">{v}</dd>
          </div>
        ))}
        <div
          role="img"
          aria-label="Contoh sesi terminal di dalam container"
          className="type-mono overflow-x-auto rounded-sm border bg-background p-3 leading-7"
        >
          <span className="text-muted-foreground">$</span> <span className="hc-typing">hermes status</span>
          <br />
          agent berjalan · menunggu pesan
          <br />
          <span className="text-muted-foreground">$</span> <span className="hc-cursor">_</span>
        </div>
      </dl>
      <p className="border-t px-4 py-3 text-xs text-muted-foreground">
        Contoh tampilan. Data di atas bukan data pelanggan nyata.
      </p>
    </aside>
  )
}
