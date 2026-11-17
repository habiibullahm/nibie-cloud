"use client"

import { useEffect, useState } from "react"
import { betaSlotsUrl, parseBetaSlots, type BetaSlots } from "@/lib/site"

/**
 * Free beta slots left, fetched once in the browser. `null` while loading or when the counter is unavailable:
 * the page then shows the call to action without a number instead of a wrong one.
 */
export function useBetaSlots(): BetaSlots | null {
  const [slots, setSlots] = useState<BetaSlots | null>(null)
  useEffect(() => {
    const url = betaSlotsUrl()
    if (!url) return
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    fetch(url, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => setSlots(parseBetaSlots(body)))
      .catch(() => undefined)
      .finally(() => clearTimeout(timer))
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [])
  return slots
}
