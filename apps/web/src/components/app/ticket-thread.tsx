"use client"

import { useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { TicketMessage } from "@/lib/api/tickets"
import { cn } from "@/lib/utils"

/**
 * The conversation of one ticket, shared by the customer page and the admin panel. Who wrote a message is said in words
 * (`authorLabel`), never by colour alone; the team's messages also sit on the elevated surface.
 */
export function TicketThread({
  messages,
  authorLabel,
  formatTime,
}: {
  messages: TicketMessage[]
  authorLabel: (m: TicketMessage) => string
  formatTime: (iso: string) => string
}) {
  return (
    <ol className="grid gap-3">
      {messages.map((m) => (
        <li key={m.id} className={cn("grid gap-2 rounded-md border p-4", m.author === "ADMIN" ? "bg-elevated" : "bg-card")}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-foreground">{authorLabel(m)}</span>
            <time dateTime={m.createdAt} className="type-mono text-muted-foreground">
              {formatTime(m.createdAt)}
            </time>
          </div>
          <p className="break-words whitespace-pre-wrap">{m.body}</p>
        </li>
      ))}
    </ol>
  )
}

/** Reply box. `onSend` resolves when saved; the box is cleared then. */
export function TicketReply({
  label,
  sendLabel,
  sendingLabel,
  onSend,
  pending,
  error,
}: {
  label: string
  sendLabel: string
  sendingLabel: string
  onSend: (message: string, done: () => void) => void
  pending: boolean
  error: string | null
}) {
  const [message, setMessage] = useState("")
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (message.trim()) onSend(message.trim(), () => setMessage(""))
      }}
    >
      <Label htmlFor="ticket-reply">{label}</Label>
      <Textarea id="ticket-reply" rows={4} maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)} />
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <Button type="submit" disabled={pending || !message.trim()}>
          {pending ? sendingLabel : sendLabel}
        </Button>
      </div>
    </form>
  )
}

/** Status chip: text first; a dashed border marks closed tickets. */
export function TicketStatusChip({ closed, children }: { closed: boolean; children: React.ReactNode }) {
  return (
    <span className={cn("type-label inline-flex w-fit shrink-0 rounded-sm border border-input px-2 py-1", closed ? "border-dashed text-muted-foreground" : "text-foreground")}>
      {children}
    </span>
  )
}
