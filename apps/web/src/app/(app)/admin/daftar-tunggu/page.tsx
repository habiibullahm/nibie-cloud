import type { Metadata } from "next"
import { AdminWaitlistView } from "./waitlist-view"

export const metadata: Metadata = { title: "Daftar tunggu" }

export default function AdminWaitlistPage() {
  return <AdminWaitlistView />
}
