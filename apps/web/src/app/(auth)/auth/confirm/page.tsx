import type { Metadata } from "next"
import { Suspense } from "react"
import { ConfirmView } from "./confirm-view"

export const metadata: Metadata = { title: "Confirming" }

export default function ConfirmPage() {
  return (
    <Suspense fallback={null}>
      <ConfirmView />
    </Suspense>
  )
}
