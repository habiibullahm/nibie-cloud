import type { TicketCategory, TicketStatus } from "./api/tickets"

/** English source texts (translated with t()). The customer sees who acts next, from their side. */
export const CUSTOMER_STATUS: Record<TicketStatus, string> = {
  OPEN: "Waiting for our team",
  ANSWERED: "Answered",
  CLOSED: "Closed",
}

/** The admin panel is Bahasa only, so these are already Indonesian. The team sees what it has to do. */
export const ADMIN_STATUS: Record<TicketStatus, string> = {
  OPEN: "Perlu dibalas",
  ANSWERED: "Sudah dibalas",
  CLOSED: "Selesai",
}

export const CATEGORY: Record<TicketCategory, string> = {
  TECHNICAL: "Technical",
  PAYMENT: "Payment",
  ACCOUNT: "Account",
  OTHER: "Other",
}

export const ADMIN_CATEGORY: Record<TicketCategory, string> = {
  TECHNICAL: "Teknis",
  PAYMENT: "Pembayaran",
  ACCOUNT: "Akun",
  OTHER: "Lainnya",
}
