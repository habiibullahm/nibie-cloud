"use client"

import { useEffect, useRef } from "react"

/**
 * Cloudflare Turnstile for the waiting-list form. The same widget (site key) as the dashboard sign-up; the backend checks
 * the token with Cloudflare. Mirrors apps/web/src/components/auth/turnstile.tsx.
 */

/** Public site key of the Turnstile widget, or null when not configured (then no widget and no captcha token). */
export function turnstileSiteKey(raw: string | undefined = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY): string | null {
  const key = raw?.trim() ?? ""
  return key === "" ? null : key
}

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string
  remove(widgetId: string): void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
let loading: Promise<TurnstileApi> | null = null

/** Loads Cloudflare's script once per page; later widgets reuse it. */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement("script")
    s.src = SCRIPT_SRC
    s.async = true
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing")))
    s.onerror = () => {
      loading = null
      reject(new Error("turnstile script failed"))
    }
    document.head.appendChild(s)
  })
  return loading
}

export type TurnstileProblem = "expired" | "unavailable" | null

/** A token works once: the parent remounts this component (a new `key`) after every submit. */
export function Turnstile({
  siteKey,
  onToken,
  onProblem,
}: {
  siteKey: string
  onToken: (token: string | null) => void
  /** Why there is no token, so the form can say so instead of leaving the button disabled without a reason. */
  onProblem: (problem: TurnstileProblem) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const handlers = useRef({ onToken, onProblem })
  useEffect(() => {
    handlers.current = { onToken, onProblem }
  }, [onToken, onProblem])
  const report = useRef((token: string | null, problem: TurnstileProblem) => {
    handlers.current.onToken(token)
    handlers.current.onProblem(problem)
  })

  useEffect(() => {
    let widget: string | null = null
    let alive = true
    loadTurnstile()
      .then((api) => {
        if (!alive || !box.current) return
        widget = api.render(box.current, {
          sitekey: siteKey,
          theme: "dark",
          size: "flexible",
          callback: (t: string) => report.current(t, null),
          "expired-callback": () => report.current(null, "expired"),
          "error-callback": () => report.current(null, "unavailable"),
        })
      })
      .catch(() => report.current(null, "unavailable"))
    return () => {
      alive = false
      if (widget && window.turnstile) window.turnstile.remove(widget)
    }
  }, [siteKey])

  return <div ref={box} className="min-h-[65px]" />
}
