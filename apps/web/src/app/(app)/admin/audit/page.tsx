import type { Metadata } from "next"
import { AdminAuditView } from "./audit-view"

export const metadata: Metadata = { title: "Audit" }

export default function AdminAuditPage() {
  return <AdminAuditView />
}
