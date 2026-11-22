import type { Metadata } from "next"
import { PageShell } from "@/components/site/page-shell"
import { Pricing } from "@/components/site/pricing"
import { pageMetadata } from "@/lib/metadata"
import { BETA_USERS, MIN_STORAGE_GB, PLAN_SPECS } from "@/lib/plans"

export const metadata: Metadata = pageMetadata({
  title: "Harga",
  description: "Harga langganan bulanan Nibie Cloud dalam Rupiah: paket Hosting dan Hosting + Kredit AI, dengan harga beta untuk 100 pengguna pertama.",
  path: "/harga",
})

export default function HargaPage() {
  return (
    <PageShell
      title="Harga"
      intro={`${PLAN_SPECS.app} dengan ${PLAN_SPECS.cpu}, ${PLAN_SPECS.ramGb} GB RAM, dan penyimpanan mulai ${MIN_STORAGE_GB} GB di region ${PLAN_SPECS.region}. Langganan bulanan dalam Rupiah. Harga beta khusus untuk pengguna beta (${BETA_USERS} pengguna pertama).`}
    >
      <Pricing headingLevel="page" />
    </PageShell>
  )
}
