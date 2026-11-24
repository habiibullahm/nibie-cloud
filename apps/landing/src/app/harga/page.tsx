import type { Metadata } from "next"
import { PageShell } from "@/components/site/page-shell"
import { Pricing } from "@/components/site/pricing"
import { pageMetadata } from "@/lib/metadata"
import { BETA_USERS, PRICING_INTRO } from "@/lib/plans"

export const metadata: Metadata = pageMetadata({
  title: "Harga",
  description: "Asisten AI pribadi Hermes di Telegram aktif 24 jam, tanpa VPS. Paket Hosting dan Pro harga beta untuk 100 pengguna pertama. Harga dalam Rupiah.",
  path: "/harga",
})

export default function HargaPage() {
  return (
    <PageShell
      title="Harga"
      intro={`${PRICING_INTRO} Langganan bulanan dalam Rupiah. Harga beta khusus untuk pengguna beta (${BETA_USERS} pengguna pertama).`}
    >
      <Pricing headingLevel="page" />
    </PageShell>
  )
}
