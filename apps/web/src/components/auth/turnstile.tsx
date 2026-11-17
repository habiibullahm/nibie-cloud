"use client"

import { useEffect, useRef } from "react"

/** Public site key of the Cloudflare Turnstile widget, or null when not configured (then no widget and no captcha token). */
export function turnstileSiteKey(): string | null {
  const key = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() ?? ""
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

/**
 * Cloudflare Turnstile. Supabase checks the token itself (Authentication → Attack Protection), so the dashboard only
 * forwards it as `captchaToken`. A token works once: the parent remounts this component (a new `key`) after every call.
 */
export function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (token: string | null) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const report = useRef(onToken)
  useEffect(() => {
    report.current = onToken
  }, [onToken])

  useEffect(() => {
    let widget: string | null = null
    let alive = true
    loadTurnstile()
      .then((api) => {
        if (!alive || !box.current) return
        widget = api.render(box.current, {
          sitekey: siteKey,
          theme: "auto",
          size: "flexible",
          callback: (t: string) => report.current(t),
          "expired-callback": () => report.current(null),
          "error-callback": () => report.current(null),
        })
      })
      .catch(() => report.current(null))
    return () => {
      alive = false
      if (widget && window.turnstile) window.turnstile.remove(widget)
    }
  }, [siteKey])

  return <div ref={box} className="min-h-[65px]" />
}
