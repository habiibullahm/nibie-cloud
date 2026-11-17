"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { GoogleButton } from "@/components/auth/google-button"
import { Turnstile, turnstileSiteKey } from "@/components/auth/turnstile"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  RESEND_COOLDOWN_S,
  authErrorMessage,
  codeLength,
  isCompleteCode,
  isEmailNotConfirmed,
  normalizeCode,
  oauthRedirectUrl,
} from "@/lib/auth/signup"
import { authConfigured, getSupabase } from "@/lib/auth/supabase"

type Step = { kind: "form" } | { kind: "code"; email: string }

/**
 * Email and password auth plus "Continue with Google" when the Supabase variables are set. A new email account is
 * confirmed with the code from the email (not a link), so it works on any device. With
 * NEXT_PUBLIC_TURNSTILE_SITE_KEY set, every email call carries a Cloudflare Turnstile token that Supabase checks.
 * Without the Supabase variables it stays a preview shell: submitting continues to the mock dashboard.
 */
export function AuthCard({ mode }: { mode: "sign-in" | "register" }) {
  const router = useRouter()
  const register = mode === "register"
  const live = authConfigured()
  const siteKey = live ? turnstileSiteKey() : null
  const [step, setStep] = useState<Step>({ kind: "form" })
  const [terms, setTerms] = useState(false)
  const [code, setCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [captcha, setCaptcha] = useState<string | null>(null)
  const [captchaRound, setCaptchaRound] = useState(0)
  const needsCaptcha = siteKey !== null && captcha === null

  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  /** A Turnstile token works once: hand it to the next call, then show a fresh widget. */
  function takeCaptcha(): { captchaToken?: string } {
    const token = captcha
    if (siteKey) {
      setCaptcha(null)
      setCaptchaRound((n) => n + 1)
    }
    return token ? { captchaToken: token } : {}
  }

  function toCode(email: string, message: string, startCooldown: boolean) {
    setStep({ kind: "code", email })
    setCode("")
    setNotice(message)
    if (startCooldown) setCooldown(RESEND_COOLDOWN_S)
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const supabase = getSupabase()
    if (!supabase) return router.push(register ? "/deploy" : "/instances")
    const form = new FormData(e.currentTarget)
    const email = String(form.get("email") ?? "").trim()
    const password = String(form.get("password") ?? "")
    const name = String(form.get("name") ?? "").trim()
    setBusy(true)
    setError(null)
    setNotice(null)
    if (register) {
      const { error: e2 } = await supabase.auth.signUp({
        email,
        password,
        options: { data: name ? { name } : undefined, ...takeCaptcha() },
      })
      setBusy(false)
      if (e2) return setError(authErrorMessage(e2, "sign-up"))
      return toCode(email, `We sent a verification code to ${email}. Enter it below to finish.`, true)
    }
    const { error: e2 } = await supabase.auth.signInWithPassword({ email, password, options: takeCaptcha() })
    setBusy(false)
    if (isEmailNotConfirmed(e2)) {
      return toCode(email, "This email is not confirmed yet. Enter the code from our email, or send a new one.", false)
    }
    if (e2) return setError(authErrorMessage(e2, "sign-in"))
    router.push("/instances")
  }

  async function verify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const supabase = getSupabase()
    if (!supabase || step.kind !== "code") return
    setBusy(true)
    setError(null)
    setNotice(null)
    const { error: e2 } = await supabase.auth.verifyOtp({ email: step.email, token: code, type: "signup", options: takeCaptcha() })
    setBusy(false)
    if (e2) return setError(authErrorMessage(e2, "verify"))
    router.push("/deploy")
  }

  async function resend() {
    const supabase = getSupabase()
    if (!supabase || step.kind !== "code") return
    setBusy(true)
    setError(null)
    setNotice(null)
    const { error: e2 } = await supabase.auth.resend({ type: "signup", email: step.email, options: takeCaptcha() })
    setBusy(false)
    if (e2) return setError(authErrorMessage(e2, "resend"))
    setNotice(`We sent a new code to ${step.email}.`)
    setCooldown(RESEND_COOLDOWN_S)
  }

  async function google() {
    const supabase = getSupabase()
    if (!supabase) return
    setError(null)
    const { error: e2 } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: oauthRedirectUrl(window.location.origin, process.env.NEXT_PUBLIC_BASE_PATH ?? "") },
    })
    if (e2) setError(authErrorMessage(e2, "google"))
  }

  const messages = (
    <>
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
    </>
  )
  const captchaWidget = siteKey ? <Turnstile key={captchaRound} siteKey={siteKey} onToken={setCaptcha} /> : null

  if (step.kind === "code") {
    const digits = codeLength()
    const partial = code.length > 0 && code.length < digits
    return (
      <Card>
        <CardHeader>
          <h1 className="type-h1">Check your email</h1>
          <CardDescription>Enter the code we sent to {step.email}.</CardDescription>
        </CardHeader>
        <form onSubmit={verify}>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="code">Verification code</Label>
              <Input
                id="code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern={`\\d{${digits}}`}
                maxLength={digits}
                placeholder={"0".repeat(digits)}
                value={code}
                aria-describedby="code-hint"
                onChange={(ev) => {
                  setCode(normalizeCode(ev.target.value, digits))
                  setError(null)
                }}
                className="font-mono tracking-[0.3em]"
              />
              <p id="code-hint" className={partial ? "text-foreground" : "text-muted-foreground"}>
                {partial ? `${code.length} of ${digits} digits.` : `The ${digits}-digit code from the email.`}
              </p>
            </div>
            {captchaWidget}
            {messages}
          </CardContent>
          <CardFooter className="mt-4 flex-col items-stretch gap-3">
            <Button type="submit" disabled={busy || !isCompleteCode(code, digits) || needsCaptcha}>
              Verify and continue
            </Button>
            <Button type="button" variant="outline" onClick={resend} disabled={busy || cooldown > 0 || needsCaptcha}>
              {cooldown > 0 ? `Send a new code (${cooldown}s)` : "Send a new code"}
            </Button>
            <p className="text-center text-muted-foreground">
              Wrong address?{" "}
              <button
                type="button"
                className="hit-area relative text-foreground underline underline-offset-4"
                onClick={() => {
                  setStep({ kind: "form" })
                  setError(null)
                  setNotice(null)
                }}
              >
                Use a different email
              </button>
            </p>
          </CardFooter>
        </form>
      </Card>
    )
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
            // First on the card: both Google and email need it, so it must be seen before either button.
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
          {live ? (
            <>
              <GoogleButton onClick={google} disabled={busy || (register && !terms)} />
              {register && !terms ? (
                <p className="text-[0.8125rem] text-muted-foreground">Tick the box above to continue with Google or email.</p>
              ) : null}
              <div className="flex items-center gap-3 text-[0.8125rem] text-muted-foreground">
                <Separator className="flex-1" />
                or with email
                <Separator className="flex-1" />
              </div>
            </>
          ) : null}
          {register ? (
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" autoComplete="name" maxLength={100} />
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
          {captchaWidget}
          {!live ? (
            <Alert>
              <AlertDescription>Sign-in is not live yet. Continuing opens the dashboard preview.</AlertDescription>
            </Alert>
          ) : null}
          {messages}
        </CardContent>
        <CardFooter className="mt-4 flex-col items-stretch gap-3">
          <Button type="submit" disabled={busy || (register && !terms) || needsCaptcha}>
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
