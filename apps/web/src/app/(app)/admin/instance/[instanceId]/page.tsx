import type { Metadata } from "next"
import { AdminInstanceView } from "./instance-view"

export const metadata: Metadata = { title: "Instance" }

export default async function AdminInstancePage({ params }: { params: Promise<{ instanceId: string }> }) {
  const { instanceId } = await params
  return <AdminInstanceView instanceId={instanceId} />
}
