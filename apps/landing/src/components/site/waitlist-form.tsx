"use client"

import { useId, useState } from "react"
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
      intro="Isi formulir ini. Begitu ada slot kosong, kami kirim undangan lewat email dengan urutan siapa yang masuk lebih dulu. Slot dipegang untukmu selama 48 jam."
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
      <div role="status" className="max-w-[62ch] rounded-md border bg-card p-6">
        <p className="type-label">Kamu sudah masuk daftar tunggu</p>
        <p className="mt-2 text-muted-foreground">
          Saat slot kosong, undangan dikirim ke {state.email}. Cek folder spam juga. Setelah undangan datang, daftar dengan email yang sama dalam 48 jam.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} noValidate className="relative grid max-w-[62ch] gap-5" aria-describedby={`${id}-status`}>
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
      <p id={`${id}-status`} role="alert" className="min-h-5 text-[0.8125rem] text-destructive">
        {state.phase === "error" ? state.message : ""}
      </p>
      <div>
        <Button type="submit" disabled={sending}>{sending ? "Mengirim…" : "Masuk daftar tunggu"}</Button>
      </div>
    </form>
  )
}
