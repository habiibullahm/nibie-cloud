import type { Wallet, WalletEntryKind, WalletTopup } from "./api/types"

/** Quick picks on the top-up dialog (owner decision 2026-11-20); any amount within the limits is also accepted. */
export const TOPUP_PRESETS = [25_000, 50_000, 100_000, 250_000] as const

export type ParsedAmount = { ok: true; value: number } | { ok: false; reason: "empty" | "not_number" | "too_low" | "too_high" }

/** Reads a typed rupiah amount. Dots, commas and spaces are thousands separators ("50.000"); no decimals. */
export function parseTopupAmount(text: string, limits: Pick<Wallet["limits"], "topupMinIdr" | "topupMaxIdr">): ParsedAmount {
  const s = text.replace(/[.,\s]/g, "")
  if (s === "") return { ok: false, reason: "empty" }
  if (!/^\d{1,10}$/.test(s)) return { ok: false, reason: "not_number" }
  const value = Number(s)
  if (value < limits.topupMinIdr) return { ok: false, reason: "too_low" }
  if (value > limits.topupMaxIdr) return { ok: false, reason: "too_high" }
  return { ok: true, value }
}

/** Largest admin adjustment either way (backend ADJUST_MAX_IDR). */
export const ADJUST_MAX_IDR = 2_000_000

/** An admin adjustment: whole rupiah, "-" to take, separators allowed; null unless non-zero and within ADJUST_MAX_IDR. */
export function parseAdjustAmount(text: string): number | null {
  const s = text.replace(/[.,\s]/g, "")
  if (!/^[+-]?\d{1,10}$/.test(s)) return null
  const n = Number(s)
  return n !== 0 && Math.abs(n) <= ADJUST_MAX_IDR ? n : null
}

/** What a ledger row was for, in words (English key for t()). */
export function entryLabel(kind: WalletEntryKind): string {
  switch (kind) {
    case "TOPUP":
      return "Top-up"
    case "HOSTING":
      return "Hosting payment"
    case "AUTO_RENEW":
      return "Automatic renewal"
    case "AI_CREDIT":
      return "AI credit"
    case "ADMIN_CREDIT":
      return "Adjustment (added)"
    case "ADMIN_DEBIT":
      return "Adjustment (deducted)"
  }
}

/** A top-up the customer can still pay. */
export function isPayable(t: WalletTopup, now = Date.now()): boolean {
  return t.status === "PENDING" && t.paymentUrl !== null && Date.parse(t.expiresAt) > now
}
