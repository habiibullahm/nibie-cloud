"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { CircleAlert } from "lucide-react"
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
  const doneRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)

  // The button is disabled while sending and replaced when done: move focus to the answer instead of the page.
  useEffect(() => {
    if (state.phase === "done") doneRef.current?.focus()
    else if (state.phase === "error") errorRef.current?.focus()
  }, [state.phase])

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
      <div
        ref={doneRef}
        tabIndex={-1}
        role="status"
        className="max-w-[62ch] rounded-md border bg-card p-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
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
      <p className="text-muted-foreground">
        Tekan Konfirmasi untuk memastikan alamat email ini milikmu. Setelah itu kamu masuk antrean beta gratis.
      </p>
      {/* Foreground color, not the destructive token (below 4.5:1 for small text); the icon and "Gagal:" carry the meaning. */}
      <p
        ref={errorRef}
        tabIndex={-1}
        role="alert"
        className="flex min-h-5 items-start gap-2 rounded-sm text-[0.8125rem] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {state.phase === "error" ? (
          <>
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>Gagal: {state.message}</span>
          </>
        ) : null}
      </p>
      <div>
        <Button type="button" disabled={sending} onClick={() => void confirm(token, url)}>
          {sending ? "Mengonfirmasi…" : "Konfirmasi"}
        </Button>
      </div>
    </div>
  )
}
