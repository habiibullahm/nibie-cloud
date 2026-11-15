import type { Metadata } from "next"
import { AdminJobsView } from "./jobs-view"

export const metadata: Metadata = { title: "Job gagal" }

export default function AdminJobsPage() {
  return <AdminJobsView />
}
