import type { Invoice } from "./api/types"
import type { T } from "./i18n"

/** Seller shown on every invoice: the same identity as the landing legal pages (owner decision 2026-11-20). */
export const SELLER = { name: "Nibie Cloud", operator: "nibie.app" } as const

/** The one line item of an invoice, in words. */
export function invoiceItem(inv: Pick<Invoice, "kind" | "planName" | "instanceName">, t: T): string {
  const vars = { plan: inv.planName ?? "", name: inv.instanceName ?? "" }
  switch (inv.kind) {
    case "TOPUP":
      return t("Nibie Cloud balance top-up")
    case "HOSTING_NEW":
      return t("{plan} plan, 30 days: {name}", vars)
    case "HOSTING_RENEWAL":
      return t("{plan} plan renewal, 30 days: {name}", vars)
    case "HOSTING_PLAN_CHANGE":
      return t("Plan change to {plan}: {name}", vars)
  }
}
