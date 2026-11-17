"use client"

import { useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { readConfirmToken, submitConfirm, waitlistConfirmUrl } from "@/lib/waitlist"

type State = { phase: "idle" } | { phase: "sending" } | { phase: "done" } | { phase: "error"; message: string }

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange)
  return () => window.removeEventListener("hashchange", onChange)
}

/** The token from the address bar; `undefined` while prerendering, when there is no address bar to read. */
function useConfirmToken(): string | null | undefined {
  return useSyncExternalStore(subscribe, () => readConfirmToken(window.location.hash), () => undefined)
}

/**
 * Double opt-in step. The token sits in the link's fragment, so it never reaches a server log; confirming needs a click,
 * so a mail scanner that opens the link does not confirm anyone.
 */
export function WaitlistConfirm() {
  const token = useConfirmToken()
  const [state, setState] = useState<State>({ phase: "idle" })
  const url = waitlistConfirmUrl()

  async function confirm(t: string, endpoint: string) {
    setState({ phase: "sending" })
    const result = await submitConfirm(endpoint, t)
    if (result.ok) {
      // The token has done its job: take it out of the address bar and the history entry.
      window.history.replaceState(null, "", window.location.pathname)
      setState({ phase: "done" })
    } else {
      setState({ phase: "error", message: result.message })
    }
  }

  if (state.phase === "done") {
    return (
      <div role="status" className="max-w-[62ch] rounded-md border bg-card p-6">
        <p className="type-label">Email terkonfirmasi, kamu sudah masuk antrean</p>
        <p className="mt-2 text-muted-foreground">
          Saat slot gratis kosong, kami kirim undangan ke alamat ini sesuai urutan. Setelah undangan datang, daftar dengan email yang sama dalam 48 jam.
        </p>
      </div>
    )
  }
  if (token === undefined) return null
  if (token === null || !url) {
    return (
      <p role="alert" className="max-w-[62ch] text-muted-foreground">
        Tautan ini tidak lengkap. Buka lagi tautan dari email konfirmasi, atau isi formulir daftar tunggu di beranda untuk tautan baru.
      </p>
    )
  }
  const sending = state.phase === "sending"
  return (
    <div className="grid max-w-[62ch] gap-4">
      <p role="alert" className="min-h-5 text-[0.8125rem] text-destructive">
        {state.phase === "error" ? state.message : ""}
      </p>
      <div>
        <Button type="button" disabled={sending} onClick={() => void confirm(token, url)}>
          {sending ? "Mengonfirmasi…" : "Konfirmasi"}
        </Button>
      </div>
    </div>
  )
}
