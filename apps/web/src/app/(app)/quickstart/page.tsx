import type { Metadata } from "next"
import { QuickstartView } from "./quickstart-view"

export const metadata: Metadata = { title: "Quickstart" }

export default function QuickstartPage() {
  return <QuickstartView />
}
