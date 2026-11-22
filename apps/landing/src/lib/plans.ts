/**
 * Public price list, decided by the owner on 2026-11-14 (docs/prd.md left pricing open; this
 * overrides it). All amounts are whole rupiah. Beta prices apply to the first 100 beta users only.
 */

export type Plan = {
  id: "hosting" | "hosting-kredit" | "pro" | "pro-kredit"
  name: string
  /** Normal price per month, shown struck through during the beta. */
  normalPriceIdr: number
  /** Beta price per month. */
  betaPriceIdr: number
  /** NibieRouter credit granted once at the start, in US dollars. 0 means none. */
  creditUsd: number
  /** CPU cores, RAM and disk of the instance; must match `Plan.cpuMillis`, `memoryMb` and `storageMb` in the production database. */
  cpu: number
  ramGb: number
  storageGb: number
}

export const BETA_USERS = 100

export const PLAN_SPECS = {
  app: "Hermes Agent",
  region: "Jakarta",
} as const

// Hosting 5 GB since 2026-11-17 (Hermes warns about low disk below 2 GiB free); Kredit 10 GB since 2026-11-20 (owner).
// Pro plans since 2026-11-23 (owner, deploy/sql/2026-11-23-pro-plans.sql).
export const PLANS: readonly Plan[] = [
  { id: "hosting", name: "Hosting", normalPriceIdr: 50_000, betaPriceIdr: 25_000, creditUsd: 0, cpu: 1, ramGb: 1, storageGb: 5 },
  { id: "hosting-kredit", name: "Hosting + Kredit AI", normalPriceIdr: 75_000, betaPriceIdr: 50_000, creditUsd: 2, cpu: 1, ramGb: 1, storageGb: 10 },
  { id: "pro", name: "Pro", normalPriceIdr: 79_000, betaPriceIdr: 49_000, creditUsd: 0, cpu: 2, ramGb: 2, storageGb: 20 },
  { id: "pro-kredit", name: "Pro + Kredit AI", normalPriceIdr: 119_000, betaPriceIdr: 79_000, creditUsd: 3, cpu: 2, ramGb: 2, storageGb: 20 },
]

/** Smallest plan on sale, for the "from X" line in the intros. */
export const MIN_CPU = Math.min(...PLANS.map((p) => p.cpu))
export const MIN_RAM_GB = Math.min(...PLANS.map((p) => p.ramGb))
export const MIN_STORAGE_GB = Math.min(...PLANS.map((p) => p.storageGb))

/** Shared intro sentence of the pricing section and the /harga page. */
export const PRICING_INTRO = `${PLAN_SPECS.app} mulai ${MIN_CPU} CPU, ${MIN_RAM_GB} GB RAM, dan penyimpanan ${MIN_STORAGE_GB} GB di region ${PLAN_SPECS.region}.`

const idr = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 })

/** 25000 -> "Rp 25.000" (always dot-grouped, independent of the runtime locale data). */
export function formatIdr(amount: number): string {
  return `Rp ${idr.format(amount).replace(/[,\s ]/g, ".")}`
}

export function discountPercent(plan: Pick<Plan, "normalPriceIdr" | "betaPriceIdr">): number {
  return Math.round((1 - plan.betaPriceIdr / plan.normalPriceIdr) * 100)
}
