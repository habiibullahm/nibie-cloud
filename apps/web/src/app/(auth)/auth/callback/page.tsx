import type { Metadata } from "next"
import { Suspense } from "react"
import { CallbackView } from "./callback-view"

export const metadata: Metadata = { title: "Signing in" }

export default function CallbackPage() {
  return (
    <Suspense fallback={null}>
      <CallbackView />
    </Suspense>
  )
}
