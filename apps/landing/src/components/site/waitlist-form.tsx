"use client"

import { useEffect, useId, useRef, useState } from "react"
import { CircleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Section } from "@/components/site/section"
import { freeBetaOpen, signupOpen } from "@/lib/site"
import { useBetaSlots } from "@/lib/use-beta-slots"
import { submitWaitlist, validateWaitlist, waitlistUrl, WAITLIST_LIMITS, type WaitlistField } from "@/lib/waitlist"

/**
 * Waiting list, shown only in free beta mode once the counter reports no free slot. Everything the page promises here is
 * done by the backend without a person: when a slot opens the oldest entry is invited by email and has 48 hours to register.
 */
export function WaitlistSection() {
  const slots = useBetaSlots()
  const url = waitlistUrl()
  if (!freeBetaOpen() || signupOpen() || !url || !slots || slots.remaining > 0) return null
  return (
    <Section
      id="daftar-tunggu"
      label="Daftar tunggu"
      title={`Semua ${slots.total} slot gratis sedang terpakai`}
      intro="Isi formulir ini lalu konfirmasi lewat tautan yang kami kirim ke emailmu. Begitu ada slot kosong, kami kirim undangan dengan urutan siapa yang masuk lebih dulu. Slot dipegang untukmu selama 48 jam."
    >
      <WaitlistForm url={url} />
    </Section>
  )
}

type State = { phase: "idle" } | { phase: "sending" } | { phase: "done"; email: string } | { phase: "error"; field?: WaitlistField; message: string }

function WaitlistForm({ url }: { url: string }) {
  const id = useId()
  const [state, setState] = useState<State>({ phase: "idle" })
  const sending = state.phase === "sending"
  const invalid = (f: WaitlistField) => state.phase === "error" && state.field === f
  const formRef = useRef<HTMLFormElement>(null)
  const statusRef = useRef<HTMLParagraphElement>(null)
  const doneRef = useRef<HTMLDivElement>(null)

  // The fields are disabled while sending and the form is replaced when done, so focus would fall back to the page.
  // Put it where the answer is: the invalid field, the error message, or the confirmation.
  useEffect(() => {
    if (state.phase === "done") doneRef.current?.focus()
    else if (state.phase === "error") {
      const field = state.field ? formRef.current?.querySelector<HTMLElement>(`[name="${state.field}"]`) : null
      ;(field ?? statusRef.current)?.focus()
    }
  }, [state])

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const data = new FormData(e.currentTarget)
    const input = {
      name: String(data.get("name") ?? ""),
      email: String(data.get("email") ?? ""),
      useCase: String(data.get("useCase") ?? ""),
      website: String(data.get("website") ?? ""),
    }
    const problem = validateWaitlist(input)
    if (problem) {
      setState({ phase: "error", field: problem.field, message: problem.message })
      return
    }
    setState({ phase: "sending" })
    const result = await submitWaitlist(url, input)
    setState(result.ok ? { phase: "done", email: input.email.trim() } : { phase: "error", message: result.message })
  }

  if (state.phase === "done") {
    return (
      <div ref={doneRef} tabIndex={-1} role="status" className="max-w-[62ch] rounded-md border bg-card p-6 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <p className="type-label">Satu langkah lagi: cek emailmu</p>
        <p className="mt-2 text-muted-foreground">
          Kami mengirim tautan konfirmasi ke {state.email} (cek folder spam juga). Buka tautan itu dan tekan Konfirmasi dalam 24 jam;
          tanpa konfirmasi kamu belum masuk antrean. Saat slot kosong, undangan dikirim ke alamat yang sama.
        </p>
      </div>
    )
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} noValidate className="relative grid max-w-[62ch] gap-5" aria-describedby={`${id}-status`}>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-name`}>Nama</Label>
        <Input id={`${id}-name`} name="name" autoComplete="name" maxLength={WAITLIST_LIMITS.name} aria-invalid={invalid("name")} disabled={sending} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-email`}>Email untuk mendaftar</Label>
        <Input id={`${id}-email`} name="email" type="email" autoComplete="email" maxLength={WAITLIST_LIMITS.email} aria-invalid={invalid("email")} disabled={sending} required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-use`}>Agent Hermes mau dipakai untuk apa?</Label>
        <Textarea id={`${id}-use`} name="useCase" rows={3} maxLength={WAITLIST_LIMITS.useCase} aria-invalid={invalid("useCase")} disabled={sending} required />
      </div>
      {/* Honeypot: out of sight and out of the tab order. A person leaves it empty; a bot that fills every field is dropped. */}
      <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Jangan diisi
          <input name="website" type="text" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      {/* Error text in the foreground color: the destructive token is below 4.5:1 for small text, so the icon and "Gagal:" carry the meaning. */}
      <p ref={statusRef} tabIndex={-1} id={`${id}-status`} role="alert" className="flex min-h-5 items-start gap-2 rounded-sm text-[0.8125rem] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {state.phase === "error" ? (
          <>
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>Gagal: {state.message}</span>
          </>
        ) : null}
      </p>
      <div>
        <Button type="submit" disabled={sending}>{sending ? "Mengirim…" : "Masuk daftar tunggu"}</Button>
      </div>
    </form>
  )
}
