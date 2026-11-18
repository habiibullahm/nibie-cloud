import type { AdminBetaInvite } from "@/lib/api/admin-types"

/** The shortest reason the backend accepts; the form checks it first so a short one never costs a request. */
export const MIN_REASON = 3

/** Text, not color alone: the status of an invite as the table and the dialog show it. */
export function inviteStatusLabel(i: Pick<AdminBetaInvite, "revokedAt">): string {
  return i.revokedAt ? "Dicabut" : "Aktif"
}

/** Something that looks like an address; the backend is the real check. */
export function looksLikeEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
}

/** Why the add form cannot be sent yet, or null when it can. */
export function addInviteProblem(f: { email: string; reason: string }): string | null {
  if (!looksLikeEmail(f.email)) return "Isi email yang valid."
  if (f.reason.trim().length < MIN_REASON) return `Alasan minimal ${MIN_REASON} karakter.`
  return null
}

/** Indonesian text for a failed change. Backend messages are English, so the panel picks its own by status. */
export function inviteErrorMessage(e: unknown): string {
  const status = typeof (e as { status?: unknown } | null)?.status === "number" ? (e as { status: number }).status : 0
  if (status === 400) return "Data tidak valid. Periksa email dan alasan."
  if (status === 401 || status === 403) return "Tidak diizinkan. Masuk lagi dan pastikan verifikasi 2 langkah aktif."
  if (status === 404) return "Undangan tidak ditemukan. Muat ulang halaman."
  return "Gagal menyimpan. Coba lagi."
}
