import type { Metadata } from "next"
import { AdminSettingsView } from "./settings-view"

export const metadata: Metadata = { title: "Pengaturan" }

export default function AdminSettingsPage() {
  return <AdminSettingsView />
}
