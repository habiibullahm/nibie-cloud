"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card"
import { destinationFor, parseConfirmParams } from "@/lib/auth/confirm"
import { getSupabase } from "@/lib/auth/supabase"

/** Landing page for the links in Supabase auth emails: verifies the token, then continues. */
export function ConfirmView() {
  const router = useRouter()
  const search = useSearchParams()
  const params = parseConfirmParams(search)
  const supabase = getSupabase()
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const started = useRef(false)
  const error =
    params === null
      ? "This link is not valid. Ask for a new email."
      : supabase === null
        ? "Sign-in is not configured in this environment."
        : verifyError

  useEffect(() => {
    // A token hash works once; strict mode runs effects twice in development.
    if (started.current || !params || !supabase) return
    started.current = true
    supabase.auth.verifyOtp({ token_hash: params.tokenHash, type: params.type }).then(({ error: e }) => {
      if (e) setVerifyError("This link is invalid or has expired. Ask for a new email.")
      else router.replace(destinationFor(params.type))
    })
  }, [router, params, supabase])

  return (
    <Card>
      <CardHeader>
        <h1 className="type-h1">{error ? "Link not accepted" : "Confirming your email"}</h1>
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
