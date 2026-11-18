import type { AdminApiKey } from "@/lib/api/admin-types"

/** Expiry choices for a new admin key, as the backend accepts them. `never` is sent as null. */
export const KEY_EXPIRY_OPTIONS = [
  { value: "30", label: "30 hari", days: 30 },
  { value: "90", label: "90 hari", days: 90 },
  { value: "365", label: "365 hari", days: 365 },
  { value: "never", label: "Tanpa batas (sampai dicabut)", days: null },
] as const

export function expiryDays(value: string): number | null {
  const o = KEY_EXPIRY_OPTIONS.find((x) => x.value === value)
  // `never` is a real null; only an unknown value falls back to the shortest expiry.
  return o ? o.days : 30
}

/** Text, not color alone. */
export function onOff(on: boolean): string {
  return on ? "Nyala" : "Mati"
}

export function keyStatusLabel(k: Pick<AdminApiKey, "revokedAt" | "expiresAt">, now: Date = new Date()): string {
  if (k.revokedAt) return "Dicabut"
  if (k.expiresAt && new Date(k.expiresAt) <= now) return "Kedaluwarsa"
  return "Aktif"
}

/** The MCP endpoint on the public API origin. Empty origin: the panel is not pointed at a backend. */
export function mcpUrl(apiOrigin: string, mcpPath: string): string {
  return apiOrigin.replace(/\/+$/, "") + mcpPath
}

/** The Claude Code command an admin runs once. The key stays a placeholder so it never lands in this page's text. */
export function claudeMcpCommand(url: string): string {
  return `claude mcp add --scope user --transport http nibiecloud-admin ${url} --header "Authorization: Bearer <KUNCI>"`
}

/** Why the create form cannot be sent yet, or null when it can. */
export function createKeyProblem(f: { name: string; reason: string }, minReason: number): string | null {
  if (!f.name.trim()) return "Isi nama kunci, misalnya laptop kantor."
  if (f.reason.trim().length < minReason) return `Alasan minimal ${minReason} karakter.`
  return null
}

/** Indonesian text for a failed key change. */
export function keyErrorMessage(e: unknown): string {
  const o = e as { status?: unknown; code?: unknown } | null
  const status = typeof o?.status === "number" ? o.status : 0
  if (status === 403 && o?.code === "session_required") return "Kunci admin hanya bisa dikelola dari panel ini, bukan lewat kunci."
  if (status === 400) return "Data tidak valid. Periksa nama, masa berlaku dan alasan."
  if (status === 401 || status === 403) return "Tidak diizinkan. Masuk lagi dan pastikan verifikasi 2 langkah aktif."
  if (status === 404) return "Kunci tidak ditemukan. Muat ulang halaman."
  return "Gagal menyimpan. Coba lagi."
}
