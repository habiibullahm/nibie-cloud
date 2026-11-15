import type { Metadata } from "next"
import { AdminInstancesView } from "./instances-view"

export const metadata: Metadata = { title: "Instance" }

export default function AdminInstancesPage() {
  return <AdminInstancesView />
}
