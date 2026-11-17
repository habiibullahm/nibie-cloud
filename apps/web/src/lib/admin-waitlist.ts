import type { AdminWaitlistEntry } from "@/lib/api/admin-types"

/** Status text for the admin waiting-list table. Text, never colour alone. */
export function waitlistStatusLabel(e: Pick<AdminWaitlistEntry, "status" | "lapsed">): string {
  if (e.status === "INVITED") return e.lapsed ? "Kedaluwarsa" : "Diundang"
  if (e.status === "REGISTERED") return "Sudah daftar"
  if (e.status === "UNCONFIRMED") return "Belum konfirmasi"
  return "Menunggu"
}
