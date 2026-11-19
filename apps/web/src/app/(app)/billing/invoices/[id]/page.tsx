import type { Metadata } from "next"
import { InvoiceView } from "./invoice-view"

export const metadata: Metadata = { title: "Invoice" }

export default function InvoicePage() {
  return <InvoiceView />
}
