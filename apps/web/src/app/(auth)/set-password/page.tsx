import type { Metadata } from "next"
import { Suspense } from "react"
import { ActionConfirmation } from "@/components/app/action-confirmation"
import { SetPasswordForm } from "./set-password-form"

export const metadata: Metadata = { title: "Set password" }

export default function SetPasswordPage() {
  // The form reads `?from=account`; useSearchParams needs a Suspense boundary.
  return (
    <Suspense fallback={null}>
      <ActionConfirmation>
        <SetPasswordForm />
      </ActionConfirmation>
    </Suspense>
  )
}
