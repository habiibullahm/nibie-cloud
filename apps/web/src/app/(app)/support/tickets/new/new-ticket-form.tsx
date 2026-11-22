"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { ArrowLeft } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { PageHeader } from "@/components/app/page-header"
import { useActionConfirmation } from "@/components/app/action-confirmation"
import { errorMessage, useCreateTicket, useInstances } from "@/hooks/use-hermes"
import { TICKET_CATEGORIES, type TicketCategory } from "@/lib/api/tickets"
import { useT } from "@/lib/i18n"
import { CATEGORY } from "@/lib/ticket-labels"

const NONE = "none"

export function NewTicketForm() {
  const t = useT()
  const confirm = useActionConfirmation()
  const router = useRouter()
  const create = useCreateTicket()
  const instances = useInstances()
  const [subject, setSubject] = useState("")
  const [category, setCategory] = useState<TicketCategory>("TECHNICAL")
  const [instanceId, setInstanceId] = useState(NONE)
  const [message, setMessage] = useState("")
  const [problem, setProblem] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (create.isPending) return
    if (subject.trim().length < 3) return setProblem(t("Write a subject of at least 3 characters."))
    if (!message.trim()) return setProblem(t("Write your message."))
    setProblem(null)
    confirm({
      title: t("Send support ticket?"),
      description: t("The Nibie Cloud team will receive your ticket about {subject}.", { subject: subject.trim() }),
      label: t("Send ticket"),
      run: () => create.mutate(
        { subject: subject.trim(), category, instanceId: instanceId === NONE ? null : instanceId, message: message.trim() },
        { onSuccess: (ticket) => router.push(`/support/tickets/${ticket.id}`) }
      ),
    })
  }

  const error = problem ?? (create.error ? errorMessage(create.error) : null)

  return (
    <form onSubmit={submit} noValidate className="grid max-w-2xl gap-6">
      <Link href="/support" className="inline-flex w-fit items-center gap-2 text-muted-foreground no-underline hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("Support")}
      </Link>
      <PageHeader title={t("Open a ticket")} description={t("Our team replies here and by email.")} />

      <div className="grid gap-2">
        <Label htmlFor="ticket-subject">{t("Subject")}</Label>
        <Input id="ticket-subject" maxLength={120} autoComplete="off" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="ticket-category">{t("Category")}</Label>
          <Select value={category} onValueChange={(v) => setCategory(v as TicketCategory)}>
            <SelectTrigger id="ticket-category" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TICKET_CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {t(CATEGORY[c])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="ticket-instance">{t("Instance (optional)")}</Label>
          <Select value={instanceId} onValueChange={setInstanceId}>
            <SelectTrigger id="ticket-instance" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t("Not about one instance")}</SelectItem>
              {(instances.data ?? []).map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  {i.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="ticket-message">{t("Message")}</Label>
        <Textarea
          id="ticket-message"
          rows={7}
          maxLength={5000}
          aria-describedby="ticket-message-hint"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <p id="ticket-message-hint" className="text-muted-foreground">
          {t("Never send passwords, API keys or bot tokens. We will never ask for them.")}
        </p>
      </div>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? t("Sending…") : t("Send ticket")}
        </Button>
      </div>
    </form>
  )
}
