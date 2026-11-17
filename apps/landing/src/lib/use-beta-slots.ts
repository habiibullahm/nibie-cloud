"use client"

import { useEffect, useState } from "react"
import { betaSlotsUrl, parseBetaSlots, type BetaSlots } from "@/lib/site"

/** One request per page load, shared by every component that shows the count. */
let pending: Promise<BetaSlots | null> | null = null

function loadBetaSlots(url: string): Promise<BetaSlots | null> {
  pending ??= (async () => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    try {
      const r = await fetch(url, { signal: ctrl.signal })
      return r.ok ? parseBetaSlots(await r.json()) : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  })()
  return pending
}

/**
 * Free beta slots left, fetched once in the browser. `null` while loading or when the counter is unavailable:
 * the page then shows the call to action without a number instead of a wrong one.
 */
export function useBetaSlots(): BetaSlots | null {
  const [slots, setSlots] = useState<BetaSlots | null>(null)
  useEffect(() => {
    const url = betaSlotsUrl()
    if (!url) return
    let live = true
    void loadBetaSlots(url).then((s) => {
      if (live) setSlots(s)
    })
    return () => {
      live = false
    }
  }, [])
  return slots
}
