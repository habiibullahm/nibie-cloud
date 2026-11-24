import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { BETA_USERS, PLANS, PLAN_SPECS, PRICING_INTRO, discountPercent, formatIdr, type Plan } from "@/lib/plans"
import { ctaHref } from "@/lib/site"
import { Section } from "./section"

export function Pricing({ headingLevel = "section" }: { headingLevel?: "section" | "page" }) {
  const body = (
    <>
      <div className="grid max-w-[840px] gap-4 md:grid-cols-2">
        {PLANS.map((p) => (
          <PlanCard key={p.id} plan={p} />
        ))}
      </div>
      <p role="note" className="mt-4 max-w-[840px] rounded-md border border-input bg-elevated p-4 text-muted-foreground">
        <strong className="font-normal text-foreground">Soal pemakaian AI. </strong>
        Kredit $2 atau $3 diberikan satu kali di awal, bukan setiap bulan. Setelah kredit habis, atau pada paket tanpa kredit,
        pemakaian AI ditagih terpisah oleh NibieRouter atau provider pilihanmu. Tidak ada janji pemakaian AI tanpa
        batas.
      </p>
      <p className="mt-4 max-w-[840px] text-[0.8125rem] text-muted-foreground">
        Harga beta khusus untuk pengguna beta ({BETA_USERS} pengguna pertama). Setelah beta, harga normal yang dicoret
        berlaku. Seluruh harga dalam Rupiah (IDR) per bulan. Lihat <a href="/kebijakan-refund" className="text-foreground underline underline-offset-4">Kebijakan Refund</a> dan{" "}
        <a href="/syarat-layanan" className="text-foreground underline underline-offset-4">Syarat Layanan</a>.
      </p>
    </>
  )
  const intro = `${PRICING_INTRO} Harga beta khusus untuk pengguna beta (${BETA_USERS} pengguna pertama).`
  if (headingLevel === "page") return <div>{body}</div>
  return (
    <Section id="harga" label="Harga" title="Langganan bulanan dalam Rupiah" intro={intro}>
      {body}
    </Section>
  )
}

function PlanCard({ plan }: { plan: Plan }) {
  const specs: [string, string][] = [
    ["Aplikasi", PLAN_SPECS.app],
    ["CPU", `${plan.cpu} core`],
    ["RAM", `${plan.ramGb} GB`],
    ["Penyimpanan", `${plan.storageGb} GB`],
    ["Region", PLAN_SPECS.region],
    ["Kredit NibieRouter", plan.creditUsd > 0 ? `$${plan.creditUsd}, sekali di awal` : "tidak termasuk"],
  ]
  return (
    <article className="grid content-start gap-4 rounded-md border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="type-label text-muted-foreground">{plan.name}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {plan.id === "hosting-kredit" ? <Badge variant="outline">Disarankan untuk mulai</Badge> : null}
          <Badge variant="outline">Beta · diskon {discountPercent(plan)}%</Badge>
        </div>
      </div>
      <p className="font-heading text-[2rem] leading-tight font-bold tracking-tight">
        <s className="mr-1 font-sans text-base font-normal text-muted-foreground">
          <span className="sr-only">Harga normal </span>
          {formatIdr(plan.normalPriceIdr)}
        </s>{" "}
        <span className="sr-only">harga beta </span>
        {formatIdr(plan.betaPriceIdr)}{" "}
        <small className="font-sans text-sm font-normal tracking-normal text-muted-foreground">/ bulan</small>
      </p>
      <dl className="grid gap-2">
        {specs.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 border-b pb-2">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="type-mono text-right">{v}</dd>
          </div>
        ))}
      </dl>
      <Button asChild variant="outline">
        <a href={ctaHref(`Minta akses beta Nibie Cloud: paket ${plan.name}`)}>Pilih {plan.name}</a>
      </Button>
    </article>
  )
}
