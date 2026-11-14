import { Section } from "./section"

const STEPS = [
  {
    title: "Pilih paket dan buat instance",
    body: "Beri nama instance, pilih paket, lalu lihat batas CPU, RAM, dan penyimpanan sebelum membayar.",
  },
  {
    title: "Bayar dengan metode Indonesia",
    body: "Pembayaran lewat payment gateway, termasuk QRIS. Instance baru diaktifkan setelah server memverifikasi pembayaranmu, bukan hanya karena kamu kembali dari halaman bayar.",
  },
  {
    title: "Hubungkan dan pakai",
    body: "Isi provider AI, sambungkan platform pesanmu (saat ini Telegram), lalu pantau status, log, dan penggunaan dari dashboard.",
  },
]

export function HowItWorks() {
  return (
    <Section id="cara-kerja" label="Cara kerja" title="Dari daftar sampai agent berjalan">
      <ol className="grid gap-4 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="grid content-start gap-3 rounded-md border bg-card p-6">
            <span className="type-mono grid size-7 place-items-center rounded-sm border border-input bg-elevated">
              {i + 1}
            </span>
            <h3 className="font-heading text-[1.0625rem] font-semibold">{s.title}</h3>
            <p className="text-muted-foreground">{s.body}</p>
          </li>
        ))}
      </ol>
    </Section>
  )
}
