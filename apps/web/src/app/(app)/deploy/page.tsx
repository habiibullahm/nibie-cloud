import type { Metadata } from "next"
import { Suspense } from "react"
import { DeployForm } from "./deploy-form"

export const metadata: Metadata = { title: "Deploy" }

export default function DeployPage() {
  // DeployForm reads `?name=&plan=` (prefill from an unpaid order); useSearchParams needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <DeployForm />
    </Suspense>
  )
}
