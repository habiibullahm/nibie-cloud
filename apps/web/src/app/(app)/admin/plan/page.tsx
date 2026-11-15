import type { Metadata } from "next"
import { AdminPlansView } from "./plans-view"

export const metadata: Metadata = { title: "Plan" }

export default function AdminPlansPage() {
  return <AdminPlansView />
}
