import type { Metadata } from "next"
import { AuthCard } from "../auth-card"

export const metadata: Metadata = { title: "Sign in" }

export default function SignInPage() {
  return <AuthCard mode="sign-in" />
}
