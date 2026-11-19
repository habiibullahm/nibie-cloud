import type { Metadata } from "next"
import { TicketView } from "./ticket-view"

export const metadata: Metadata = { title: "Ticket" }

export default function TicketPage() {
  return <TicketView />
}
