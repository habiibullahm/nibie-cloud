import { formatPriceIdr } from "./format"

/** Same bounds as the backend (ai-account.ts ALERT_MIN_IDR / ALERT_MAX_IDR). */
export const AI_ALERT_MIN_IDR = 1_000
export const AI_ALERT_MAX_IDR = 1_000_000

/** The reminder amount typed by the customer ("10.000", "Rp 25000") as whole rupiah, or null when it is not a valid amount. */
export function parseAiThreshold(text: string): number | null {
  const digits = text.replace(/[^\d]/g, "")
  if (digits === "" || digits.length > 9) return null
  const n = Number(digits)
  return n >= AI_ALERT_MIN_IDR && n <= AI_ALERT_MAX_IDR ? n : null
}

/** Rupiah when a rate is known, otherwise US$ with cents (the router counts in US$). */
export function formatAiAmount(idr: number | null, usd: number, lang: "en" | "id" = "en"): string {
  if (idr !== null) return formatPriceIdr(idr, lang)
  return `US$${usd.toFixed(2)}`
}
