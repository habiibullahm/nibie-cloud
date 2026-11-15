import type { Metadata } from "next"
import { AdminOverviewView } from "./admin-overview-view"

export const metadata: Metadata = { title: "Admin" }

export default function AdminPage() {
  return <AdminOverviewView />
}
