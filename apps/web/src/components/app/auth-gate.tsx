"use client"

import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { getSupabase } from "@/lib/auth/supabase"

/**
 * Sends visitors without a session to /sign-in. When Supabase is not configured (the preview and
 * local mock mode) it renders its children untouched.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const supabase = getSupabase()
  const [ready, setReady] = useState(supabase === null)

  useEffect(() => {
    if (!supabase) return
    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      if (data.session) setReady(true)
      else router.replace("/sign-in")
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) router.replace("/sign-in")
    })
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [supabase, router])

  if (ready) return <>{children}</>
  // Announced to screen readers and visible, so the check never looks like a blank, frozen page.
  return (
    <div role="status" className="flex min-h-dvh items-center justify-center gap-2 px-4 text-muted-foreground">
      <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      Checking your session…
    </div>
  )
}
