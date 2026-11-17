import type { Metadata } from "next"
import { PageShell } from "@/components/site/page-shell"
import { SITE, contactEmail } from "@/lib/site"

export const metadata: Metadata = {
  title: "Kontak",
  description: "Hubungi tim Nibie Cloud untuk pertanyaan, akses beta, refund, atau bantuan teknis.",
  alternates: { canonical: "/kontak" },
}

// At least 44x44px on touch (hit-area) and the button focus ring, without changing how the link reads in the row.
const linkClass =
  "hit-area relative rounded-sm text-foreground underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"

export default function KontakPage() {
  const email = contactEmail()
  return (
    <PageShell title="Kontak" intro="Pertanyaan tentang layanan, akses beta, pembayaran, refund, atau masalah teknis? Hubungi kami lewat salah satu saluran di bawah.">
      <dl className="grid max-w-[620px] gap-4">
        {email ? (
          <Row label="Email">
            <a href={`mailto:${email}`} className={linkClass}>
              {email}
            </a>
          </Row>
        ) : null}
        <Row label="Telegram">
          <a href={SITE.telegramUrl} rel="noopener noreferrer" className={linkClass}>
            {SITE.telegramHandle}
          </a>
        </Row>
        <Row label="Penyelenggara">{SITE.operator}</Row>
        <Row label="Layanan">
          {SITE.name} (<a href={SITE.url} className={linkClass}>cloud.nibie.app</a>)
        </Row>
      </dl>
      <p className="max-w-[62ch] text-muted-foreground">
        Sebutkan alamat email akunmu dan, untuk masalah pembayaran, waktu serta metode pembayarannya. Jangan pernah
        mengirim kata sandi, API key, atau token bot lewat email atau Telegram.
      </p>
    </PageShell>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-6 gap-y-1 rounded-md border bg-card p-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}
