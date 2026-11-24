import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Section } from "./section"

const FAQ = [
  {
    q: "Apakah saya perlu punya VPS atau mengerti Docker?",
    a: "Tidak. Kami menyediakan container dan penyimpanan untuk instance Hermes-mu, dan mengurus operasinya. Kamu bekerja lewat dashboard dan shell di dalam container.",
  },
  {
    q: "Apakah pemakaian AI sudah termasuk di paket?",
    a: "Paket Hosting dan Pro tidak termasuk pemakaian AI. Paket Hosting + Kredit AI memberi kredit NibieRouter $2, dan Pro + Kredit AI $3, setiap periode yang dibayar. Kredit yang tidak terpakai tetap di saldo AI. Di luar kredit itu, pemakaian AI ditagih terpisah, lewat NibieRouter atau API key provider milikmu sendiri. Kami tidak menjanjikan pemakaian AI tanpa batas.",
  },
  {
    q: "Seberapa terisolasi instance saya dari pelanggan lain?",
    a: "Setiap pelanggan mendapat container dan volume sendiri, dengan jaringan terpisah. Container tidak punya akses ke server host maupun ke data pelanggan lain.",
  },
  {
    q: "Bagaimana cara membayar dan kapan instance aktif?",
    a: "Pembayaran lewat payment gateway dengan metode yang umum di Indonesia, termasuk QRIS. Instance aktif setelah server memverifikasi pembayaran.",
  },
  {
    q: "Bagaimana kebijakan refund?",
    a: "Refund penuh bila diminta dalam 7 hari setelah pembayaran pertama dan instance belum dipakai. Setelah itu pembayaran langganan yang sudah berjalan tidak dikembalikan, dan pemakaian AI lewat NibieRouter tidak bisa di-refund. Syarat lengkap ada di Kebijakan Refund.",
  },
]

export function Faq() {
  return (
    <Section id="faq" label="FAQ" title="Pertanyaan yang sering muncul">
      <Accordion type="single" collapsible defaultValue="item-0" className="rounded-md border bg-card">
        {FAQ.map((f, i) => (
          <AccordionItem key={f.q} value={`item-${i}`}>
            <AccordionTrigger>{f.q}</AccordionTrigger>
            <AccordionContent>
              {f.a}
              {i === FAQ.length - 1 ? (
                <>
                  {" "}
                  <a href="/kebijakan-refund" className="text-foreground underline underline-offset-4">
                    Baca selengkapnya
                  </a>
                  .
                </>
              ) : null}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </Section>
  )
}
