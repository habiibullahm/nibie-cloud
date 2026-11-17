/**
 * Public price list, decided by the owner on 2026-11-14 (docs/prd.md left pricing open; this
 * overrides it). All amounts are whole rupiah. Beta prices apply to the first 100 beta users only.
 */

export type Plan = {
  id: "hosting" | "hosting-kredit"
  name: string
  /** Normal price per month, shown struck through during the beta. */
  normalPriceIdr: number
  /** Beta price per month. */
  betaPriceIdr: number
  /** NibieRouter credit granted once at the start, in US dollars. 0 means none. */
  creditUsd: number
}

export const BETA_USERS = 100

export const PLAN_SPECS = {
  app: "Hermes Agent",
  cpu: "1 CPU",
  ramGb: 1,
  // 5 GB since 2026-11-17: Hermes warns about low disk below 2 GiB free, so 1 GB warned on every instance.
  storageGb: 5,
  region: "Jakarta",
} as const

export const PLANS: readonly Plan[] = [
  { id: "hosting", name: "Hosting", normalPriceIdr: 50_000, betaPriceIdr: 25_000, creditUsd: 0 },
  { id: "hosting-kredit", name: "Hosting + Kredit AI", normalPriceIdr: 75_000, betaPriceIdr: 50_000, creditUsd: 2 },
]

const idr = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 })

/** 25000 -> "Rp 25.000" (always dot-grouped, independent of the runtime locale data). */
export function formatIdr(amount: number): string {
  return `Rp ${idr.format(amount).replace(/[,\s ]/g, ".")}`
}

export function discountPercent(plan: Pick<Plan, "normalPriceIdr" | "betaPriceIdr">): number {
  return Math.round((1 - plan.betaPriceIdr / plan.normalPriceIdr) * 100)
}
