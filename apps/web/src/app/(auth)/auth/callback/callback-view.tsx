"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card"
import { authErrorMessage, isFreshUser } from "@/lib/auth/signup"
import { getSupabase } from "@/lib/auth/supabase"

/** Where Google sends the person back (PKCE): trades the one-time `code` for a session, then continues. */
export function CallbackView() {
  const router = useRouter()
  const search = useSearchParams()
  const code = search.get("code") ?? ""
  // Google or Supabase can come back with an error instead of a code (cancelled consent, provider off).
  const returnedError = search.get("error_code") ?? search.get("error")
  const supabase = getSupabase()
  const [exchangeError, setExchangeError] = useState<string | null>(null)
  const started = useRef(false)
  const error =
    supabase === null
      ? "Sign-in is not configured in this environment."
      : returnedError !== null
        ? authErrorMessage({ code: returnedError }, "google")
        : code === ""
          ? "This sign-in link is not complete. Start again."
          : exchangeError

  useEffect(() => {
    // A code works once; strict mode runs effects twice in development.
    if (started.current || !supabase || returnedError !== null || code === "") return
    started.current = true
    supabase.auth.exchangeCodeForSession(code).then(({ data, error: e }) => {
      if (e) return setExchangeError(authErrorMessage(e, "google"))
      router.replace(isFreshUser(data.user?.created_at) ? "/deploy" : "/instances")
    })
  }, [router, supabase, code, returnedError])

  return (
    <Card>
      <CardHeader>
        <h1 className="type-h1">{error ? "Sign-in not finished" : "Signing you in"}</h1>
        <CardDescription>{error ? "We could not finish this step." : "One moment."}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? (
          <>
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
            <Button asChild>
              <Link href="/sign-in">Go to sign in</Link>
            </Button>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
