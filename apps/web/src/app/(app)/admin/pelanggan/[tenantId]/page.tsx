import type { Metadata } from "next"
import { AdminCustomerView } from "./customer-view"

export const metadata: Metadata = { title: "Pelanggan" }

export default async function AdminCustomerPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params
  return <AdminCustomerView tenantId={tenantId} />
}
