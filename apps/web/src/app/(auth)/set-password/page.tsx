import type { Metadata } from "next"
import { SetPasswordForm } from "./set-password-form"

export const metadata: Metadata = { title: "Set password" }

export default function SetPasswordPage() {
  return <SetPasswordForm />
}
