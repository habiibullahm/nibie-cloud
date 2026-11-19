import type { Metadata } from "next"
import { AdminTicketView } from "./ticket-view"

export const metadata: Metadata = { title: "Tiket" }

export default async function AdminTicketPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params
  return <AdminTicketView ticketId={ticketId} />
}
