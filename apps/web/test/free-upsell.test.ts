import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { FreeUpsell } from "@/components/app/free-upsell"
import { PLANS as MOCK_PLANS } from "@/lib/api/mock"
import type { Plan } from "@/lib/api/types"
import { FixedLang } from "@/lib/i18n"

const FREE_PLAN: Plan = {
  id: "plan-free",
  slug: "free",
  name: "Free",
  cpuMillis: 500,
  memoryMb: 1024,
  storageMb: 5120,
  pids: 256,
  backupRetentionDays: null,
  customDomain: null,
  monthlyPriceIdr: null,
  includedCreditUsd: null,
  available: true,
}

const KREDIT_PLAN: Plan = {
  id: "plan-kredit",
  slug: "hosting-kredit",
  name: "Hosting + Kredit AI",
  cpuMillis: 1000,
  memoryMb: 1024,
  storageMb: 10240,
  pids: 256,
  backupRetentionDays: 7,
  customDomain: null,
  monthlyPriceIdr: 50_000,
  includedCreditUsd: 2,
  available: true,
}

const PAID_PLAN: Plan = {
  id: "plan-hosting",
  slug: "hosting",
  name: "Hosting",
  cpuMillis: 1000,
  memoryMb: 1024,
  storageMb: 5120,
  pids: 256,
  backupRetentionDays: 7,
  customDomain: null,
  monthlyPriceIdr: 25_000,
  includedCreditUsd: null,
  available: true,
}

describe("FreeUpsell", () => {
  it("FreeUpsell shows the Kredit plan price for a free instance", () => {
    const html = renderToStaticMarkup(
      createElement(
        FixedLang,
        { value: "en" },
        createElement(FreeUpsell, {
          instanceId: "inst-1",
          planId: FREE_PLAN.id,
          plans: [FREE_PLAN, KREDIT_PLAN],
        })
      )
    )
    expect(html).toContain("Free plan uses free AI models")
    expect(html).toContain("Hosting + Kredit AI")
    expect(html).toContain("50.000")
    expect(html).toContain("includes US$2 AI credit every month for faster models.")
    expect(html).toContain("See paid plans")
    expect(html).toContain('href="/instances/inst-1/billing"')
  })

  it("FreeUpsell renders nothing on a paid instance", () => {
    const html = renderToStaticMarkup(
      createElement(FreeUpsell, {
        instanceId: "inst-1",
        planId: PAID_PLAN.id,
        plans: [FREE_PLAN, PAID_PLAN, KREDIT_PLAN],
      })
    )
    expect(html).toBe("")
  })

  it("FreeUpsell renders nothing when hosting-kredit is sold out", () => {
    const soldOut: Plan = { ...KREDIT_PLAN, available: false }
    const html = renderToStaticMarkup(
      createElement(FreeUpsell, {
        instanceId: "inst-1",
        planId: FREE_PLAN.id,
        plans: [FREE_PLAN, soldOut],
      })
    )
    expect(html).toBe("")
  })

  it("renders nothing in mock mode when hosting-kredit is absent", () => {
    const html = renderToStaticMarkup(
      createElement(FreeUpsell, {
        instanceId: "inst-1",
        planId: MOCK_PLANS[0]!.id,
        plans: MOCK_PLANS,
      })
    )
    expect(html).toBe("")
  })

  it("renders Indonesian copy when language is id", () => {
    const html = renderToStaticMarkup(
      createElement(
        FixedLang,
        { value: "id" },
        createElement(FreeUpsell, {
          instanceId: "inst-1",
          planId: FREE_PLAN.id,
          plans: [FREE_PLAN, KREDIT_PLAN],
        })
      )
    )
    expect(html).toContain("Paket gratis memakai model AI gratis")
    expect(html).toContain("US$2 setiap bulan")
    expect(html).toContain("Lihat paket berbayar")
  })
})
