"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authConfigured, getSupabase } from "@/lib/auth/supabase"

/**
 * Real email and password auth when the Supabase variables are set. Without them it stays a preview
 * shell: submitting continues to the mock dashboard.
 */
export function AuthCard({ mode }: { mode: "sign-in" | "register" }) {
  const router = useRouter()
  const [terms, setTerms] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const register = mode === "register"
  const live = authConfigured()

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const supabase = getSupabase()
    if (!supabase) return router.push(register ? "/deploy" : "/instances")
    const form = new FormData(e.currentTarget)
    const email = String(form.get("email") ?? "").trim()
    const password = String(form.get("password") ?? "")
    setBusy(true)
    setError(null)
    if (register) {
      const { error: e2 } = await supabase.auth.signUp({ email, password })
      setBusy(false)
      if (e2) return setError("Could not create the account. Check the details and try again.")
      return setNotice("Check your inbox and open the confirmation link to finish.")
    }
    const { error: e2 } = await supabase.auth.signInWithPassword({ email, password })
    setBusy(false)
    if (e2) return setError("Email or password is not correct.")
    router.push("/instances")
  }

  return (
    <Card>
      <CardHeader>
        <h1 className="type-h1">{register ? "Create account" : "Sign in"}</h1>
        <CardDescription>
          {register ? "Deploy your own Hermes agent." : "Welcome back. Manage your Hermes instances."}
        </CardDescription>
      </CardHeader>
      <form onSubmit={submit}>
        <CardContent className="grid gap-4">
          {register ? (
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" autoComplete="name" />
            </div>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" autoComplete={register ? "new-password" : "current-password"} />
          </div>
          {register ? (
            <div className="flex items-start gap-3">
              <Checkbox id="terms" checked={terms} onCheckedChange={(v) => setTerms(v === true)} className="mt-1" />
              <Label htmlFor="terms" className="block text-muted-foreground">
                I agree to the{" "}
                <a href="https://cloud.nibie.app/syarat-layanan" target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4">
                  Terms of Service
                </a>
                ,{" "}
                <a href="https://cloud.nibie.app/kebijakan-privasi" target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4">
                  Privacy Policy
                </a>{" "}
                and{" "}
                <a href="https://cloud.nibie.app/kebijakan-refund" target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-4">
                  Refund Policy
                </a>
                . They are written in Indonesian.
              </Label>
            </div>
          ) : null}
          {!live ? (
            <Alert>
              <AlertDescription>Sign-in is not live yet. Continuing opens the dashboard preview.</AlertDescription>
            </Alert>
          ) : null}
          {error ? (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {notice ? (
            <Alert role="status">
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="mt-4 flex-col items-stretch gap-3">
          <Button type="submit" disabled={busy || (register && !terms)}>
            {register ? "Create account" : "Sign in"}
          </Button>
          <p className="text-center text-muted-foreground">
            {register ? "Already have an account? " : "New to Nibie Cloud? "}
            <Link href={register ? "/sign-in" : "/register"} className="hit-area relative text-foreground">
              {register ? "Sign in" : "Create an account"}
            </Link>
          </p>
        </CardFooter>
      </form>
    </Card>
  )
}
