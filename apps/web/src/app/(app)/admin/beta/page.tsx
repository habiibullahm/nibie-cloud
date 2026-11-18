import type { Metadata } from "next"
import { AdminBetaView } from "./beta-view"

export const metadata: Metadata = { title: "Undangan beta" }

export default function AdminBetaPage() {
  return <AdminBetaView />
}
