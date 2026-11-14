import Link from "next/link"
import { Button } from "@/components/ui/button"
import { PageShell } from "@/components/site/page-shell"

export default function NotFound() {
  return (
    <PageShell title="Halaman tidak ditemukan" intro="Alamat yang kamu buka tidak ada atau sudah dipindahkan.">
      <div>
        <Button asChild variant="outline">
          <Link href="/">Kembali ke beranda</Link>
        </Button>
      </div>
    </PageShell>
  )
}
