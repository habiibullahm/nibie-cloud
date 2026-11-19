import type { Metadata } from "next"
import { AdminTicketsView } from "./tickets-view"

export const metadata: Metadata = { title: "Tiket" }

export default function AdminTicketsPage() {
  return <AdminTicketsView />
}
