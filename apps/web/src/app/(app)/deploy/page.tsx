import type { Metadata } from "next"
import { DeployForm } from "./deploy-form"

export const metadata: Metadata = { title: "Deploy" }

export default function DeployPage() {
  return <DeployForm />
}
