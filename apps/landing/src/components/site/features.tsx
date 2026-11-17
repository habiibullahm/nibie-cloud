import { Database, Globe, KeyRound, MessagesSquare, SquareTerminal, type LucideIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Section } from "./section"
import { cn } from "@/lib/utils"

/** `planned`: not built yet. The card says so in its badge and in its text, and promises nothing about plans. */
type Feature = { icon: LucideIcon; title: string; body: string; planned?: boolean; span: string }

const FEATURES: Feature[] = [
  {
    icon: SquareTerminal,
    title: "Container terisolasi dengan shell penuh",
    body: "Hermes berjalan di container khusus milikmu. Di dalamnya kamu punya akses shell penuh dan semua fitur Hermes. Tidak ada akses ke server host, dan jaringan antar pelanggan dipisahkan.",
    span: "lg:col-span-4",
  },
  {
    icon: MessagesSquare,
    title: "Telegram sekarang, platform lain menyusul",
    body: "Saat beta, dashboard menyambungkan agent-mu ke Telegram dengan token bot milikmu, disimpan terenkripsi dan tidak pernah ditampilkan ulang. Hermes sendiri bisa bicara lewat platform pesan lain seperti Discord, Slack, WhatsApp, dan Signal; penyambungannya lewat dashboard menyusul.",
    span: "lg:col-span-2",
  },
  {
    icon: KeyRound,
    title: "NibieRouter atau kunci sendiri",
    body: "Pakai NibieRouter sebagai jalur AI bawaan, atau bawa API key dari provider pilihanmu. Pemakaian AI ditagih terpisah.",
    span: "lg:col-span-2",
  },
  {
    icon: Database,
    title: "Backup dan pemulihan",
    body: "Rencananya salinan data instance disimpan terpisah dari server utama. Frekuensi dan lama penyimpanannya belum ditetapkan.",
    planned: true,
    span: "lg:col-span-2",
  },
  {
    icon: Globe,
    title: "Domain sendiri",
    body: "Rencananya kamu bisa mengarahkan domainmu sendiri ke instance, dengan verifikasi DNS.",
    planned: true,
    span: "lg:col-span-2",
  },
]

export function Features() {
  return (
    <Section
      id="fitur"
      label="Fitur"
      title="Yang kamu dapat, tanpa menyentuh infrastruktur"
      intro="Setiap instance berjalan sendiri. Kamu mengatur agent, kami mengurus tempat berjalannya."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        {FEATURES.map(({ icon: Icon, title, body, planned, span }) => (
          <article key={title} className={cn("grid content-start gap-3 rounded-md border bg-card p-6", span)}>
            <div className="flex items-center justify-between gap-3">
              <span className="grid size-8 place-items-center rounded-sm border border-input bg-elevated">
                <Icon aria-hidden className="size-4" />
              </span>
              {planned ? <Badge variant="outline">Belum tersedia</Badge> : null}
            </div>
            <h3 className="font-heading text-[1.0625rem] font-semibold">{title}</h3>
            <p className="text-muted-foreground">{body}</p>
          </article>
        ))}
      </div>
    </Section>
  )
}
