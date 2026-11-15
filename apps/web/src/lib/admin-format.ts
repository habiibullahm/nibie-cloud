/**
 * Formatting helpers for the admin panel only. The customer dashboard stays English
 * (`lib/format.ts`); the admin UI is Indonesian, so it gets its own helpers rather than changing
 * output the customer screens already rely on.
 */

/** `15 Nov 2026, 19.23` in the viewer's timezone. An unparseable value is shown as-is, never "Invalid Date". */
export function formatDateTimeId(iso: string | null): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  return new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(t)
}

/** A byte count up to GB, or `—` when the backend has not measured it. Accepts the BigInt-as-string JSON shape. */
export function formatBytesId(bytes: string | number | null): string {
  if (bytes === null || bytes === "") return "—"
  const n = typeof bytes === "string" ? Number(bytes) : bytes
  if (!Number.isFinite(n)) return "—"
  if (n < 1024) return `${n} B`
  const mb = n / 1024 / 1024
  if (mb < 1) return `${(n / 1024).toFixed(1)} KB`
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/** Rupiah without decimals; `null` means the plan is not for sale. */
export function formatIdr(amount: number | null): string {
  if (amount === null) return "Belum dijual"
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(amount)
}

/** A US$ credit, or `—` when the plan has none. */
export function formatUsd(amount: number | null): string {
  if (amount === null) return "—"
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(amount)
}
