import type { Metadata } from "next"
import { InstancesView } from "./instances-view"

export const metadata: Metadata = { title: "Instances" }

export default function InstancesPage() {
  return <InstancesView />
}
