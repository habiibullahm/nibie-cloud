/**
 * Formatting helpers for the admin panel only. The customer dashboard stays English
 * (`lib/format.ts`); the admin UI is Indonesian, so it gets its own helpers rather than changing
 * output the customer screens already rely on.
 */

/** Shown where a value is empty. A plain hyphen, never an em dash (antislop R-02). */
export const EMPTY = "-"

/** `15 Nov 2026, 19.23` in the viewer's timezone. An unparseable value is shown as-is, never "Invalid Date". */
export function formatDateTimeId(iso: string | null): string {
  if (!iso) return EMPTY
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

/** A byte count up to GB, or `-` when the backend has not measured it. Accepts the BigInt-as-string JSON shape. */
export function formatBytesId(bytes: string | number | null): string {
  if (bytes === null || bytes === "") return EMPTY
  const n = typeof bytes === "string" ? Number(bytes) : bytes
  if (!Number.isFinite(n)) return EMPTY
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

/** A US$ credit, or "Tidak ada" when the plan has none. */
export function formatUsd(amount: number | null): string {
  if (amount === null) return "Tidak ada"
  return new Intl.NumberFormat("id-ID", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(amount)
}

// Indonesian labels for backend enums (prisma/schema.prisma). An unknown value is shown raw rather than hidden,
// so a new backend state is still visible to the operator.

const INSTANCE_STATUS: Record<string, string> = {
  PENDING: "Antre",
  PROVISIONING: "Menyiapkan",
  CONFIGURING: "Mengonfigurasi",
  STARTING: "Memulai",
  ACTIVE: "Aktif",
  DEGRADED: "Terganggu",
  STOPPING: "Menghentikan",
  STOPPED: "Berhenti",
  FAILED: "Gagal",
  DELETING: "Menghapus",
  DELETED: "Dihapus",
  SUSPENDED: "Ditangguhkan",
}

const SUBSCRIPTION_STATUS: Record<string, string> = {
  PENDING_PAYMENT: "Menunggu pembayaran",
  ACTIVE: "Aktif",
  GRACE: "Masa tenggang",
  SUSPENDED: "Ditangguhkan",
  ENDED: "Berakhir",
}

const PAYMENT_STATUS: Record<string, string> = {
  PENDING: "Menunggu",
  PAID: "Dibayar",
  FAILED: "Gagal",
  EXPIRED: "Kedaluwarsa",
}

const PAYMENT_PURPOSE: Record<string, string> = {
  NEW: "Instance baru",
  RENEWAL: "Perpanjangan",
  PLAN_CHANGE: "Ganti paket",
}

const INTEGRATION_STATUS: Record<string, string> = {
  UNTESTED: "Belum dites",
  OK: "Tersambung",
  FAILED: "Gagal",
}

const PROVIDER_KIND: Record<string, string> = {
  NIBIEROUTER: "NibieRouter",
  BYOK: "Kunci sendiri",
}

export const instanceStatusId = (s: string): string => INSTANCE_STATUS[s] ?? s
export const subscriptionStatusId = (s: string): string => SUBSCRIPTION_STATUS[s] ?? s
export const paymentStatusId = (s: string): string => PAYMENT_STATUS[s] ?? s
export const paymentPurposeId = (s: string): string => PAYMENT_PURPOSE[s] ?? s
export const integrationStatusId = (s: string): string => INTEGRATION_STATUS[s] ?? s
export const providerKindId = (s: string): string => PROVIDER_KIND[s] ?? s
