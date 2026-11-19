"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { validateNewPassword } from "@/lib/auth/password"
import { getSupabase } from "@/lib/auth/supabase"

/**
 * Shown after an invitation or password-reset link (the session exists, the password does not), and from the Account
 * page (`?from=account`), where the customer is signed in normally and goes back to Account afterwards.
 */
export function SetPasswordForm() {
  const router = useRouter()
  const fromAccount = useSearchParams().get("from") === "account"
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const invalid = validateNewPassword(password, confirm)
    if (invalid) return setError(invalid)
    const supabase = getSupabase()
    if (!supabase) return setError("Sign-in is not configured in this environment.")
    setBusy(true)
    setError(null)
    const { error: e2 } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (e2) {
      return setError(
        fromAccount
          ? "Could not save the password. Try again, or sign out and sign in again first."
          : "Could not save the password. Open the link from your email again."
      )
    }
    router.replace(fromAccount ? "/account" : "/deploy")
  }

  return (
    <Card>
      <CardHeader>
        <h1 className="type-h1">Set your password</h1>
        <CardDescription>Choose a password for your account.</CardDescription>
      </CardHeader>
      <form onSubmit={submit}>
        <CardContent className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="new-password">New password</Label>
            <Input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="confirm-password">Repeat password</Label>
            <Input id="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </div>
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="mt-4 flex-col items-stretch gap-3">
          <Button type="submit" disabled={busy}>
            Save password
          </Button>
          {fromAccount ? (
            <Button asChild variant="ghost">
              <Link href="/account">Back to account</Link>
            </Button>
          ) : null}
        </CardFooter>
      </form>
    </Card>
  )
}
