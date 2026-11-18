import type { AdminPlan } from "@/lib/api/admin-types"

/** The highest stock the backend accepts. */
export const MAX_STOCK = 100000

/** Text for the Stok column. Not color alone: a sold-out plan says so in words. */
export function stockLabel(p: Pick<AdminPlan, "monthlyPriceIdr" | "stockLimit" | "stockUsed" | "stockLeft">): string {
  if (p.monthlyPriceIdr === null) return `Slot beta (${p.stockUsed} terpakai)`
  if (p.stockLimit === null) return `Tanpa batas (${p.stockUsed} terpakai)`
  if (p.stockLeft === 0) return `Habis (${p.stockUsed}/${p.stockLimit})`
  return `Sisa ${p.stockLeft} dari ${p.stockLimit}`
}

/** The form value as the backend wants it: empty means no limit; anything else must be a whole number 0..MAX_STOCK. */
export function parseStock(v: string): { ok: true; value: number | null } | { ok: false } {
  const t = v.trim()
  if (t === "") return { ok: true, value: null }
  if (!/^\d+$/.test(t)) return { ok: false }
  const n = Number(t)
  return n <= MAX_STOCK ? { ok: true, value: n } : { ok: false }
}

/** Indonesian text for a failed change. Backend messages are English, so the panel picks its own by status and code. */
export function stockErrorMessage(e: unknown): string {
  const err = e as { status?: unknown; code?: unknown } | null
  if (err?.code === "free_plan_stock") return "Plan gratis dibatasi FREE_BETA_SLOTS, bukan stok."
  const status = typeof err?.status === "number" ? err.status : 0
  if (status === 400) return "Data tidak valid. Periksa angka stok dan alasan."
  if (status === 401 || status === 403) return "Tidak diizinkan. Masuk lagi dan pastikan verifikasi 2 langkah aktif."
  if (status === 404) return "Plan tidak ditemukan. Muat ulang halaman."
  return "Gagal menyimpan. Coba lagi."
}
