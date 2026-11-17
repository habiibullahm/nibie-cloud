import type { Metadata } from "next"
import { PageShell } from "@/components/site/page-shell"
import { WaitlistConfirm } from "@/components/site/waitlist-confirm"

export const metadata: Metadata = {
  title: "Konfirmasi daftar tunggu",
  description: "Konfirmasi alamat email untuk daftar tunggu beta gratis Nibie Cloud.",
  // A one-time page reached from an email: never indexed, not in the sitemap.
  robots: { index: false, follow: false },
}

export default function KonfirmasiDaftarTungguPage() {
  return (
    <PageShell title="Konfirmasi daftar tunggu" intro="Halaman ini memastikan alamat email untuk daftar tunggu beta gratis Nibie Cloud.">
      <WaitlistConfirm />
    </PageShell>
  )
}
