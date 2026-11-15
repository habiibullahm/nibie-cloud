import type { Metadata } from "next"
import { AdminBillingView } from "./billing-view"

export const metadata: Metadata = { title: "Langganan" }

export default function AdminBillingPage() {
  return <AdminBillingView />
}
