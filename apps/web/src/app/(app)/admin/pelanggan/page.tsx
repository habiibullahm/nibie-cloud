import type { Metadata } from "next"
import { AdminCustomersView } from "./customers-view"

export const metadata: Metadata = { title: "Pelanggan" }

export default function AdminCustomersPage() {
  return <AdminCustomersView />
}
