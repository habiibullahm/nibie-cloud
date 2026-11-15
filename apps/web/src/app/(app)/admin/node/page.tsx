import type { Metadata } from "next"
import { AdminNodesView } from "./nodes-view"

export const metadata: Metadata = { title: "Node" }

export default function AdminNodesPage() {
  return <AdminNodesView />
}
