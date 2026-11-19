"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useState } from "react"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/app/page-header"
import { QueryFallback } from "@/components/app/query-fallback"
import { TicketReply, TicketStatusChip, TicketThread } from "@/components/app/ticket-thread"
import { errorMessage, useTicket, useTicketAction } from "@/hooks/use-hermes"
import { formatRelative } from "@/lib/format"
import { useT } from "@/lib/i18n"
import { useLang } from "@/lib/prefs"
import { CATEGORY, CUSTOMER_STATUS } from "@/lib/ticket-labels"

export function TicketView() {
  const t = useT()
  const lang = useLang()
  const { id } = useParams<{ id: string }>()
  const ticket = useTicket(id)
  const action = useTicketAction(id)
  const [error, setError] = useState<string | null>(null)
  const k = ticket.data

  return (
    <div className="grid max-w-3xl gap-6">
      <Link href="/support" className="inline-flex w-fit items-center gap-2 text-muted-foreground no-underline hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("Support")}
      </Link>

      {!k ? (
        <QueryFallback what="ticket" queries={[ticket]} />
      ) : (
        <>
          <PageHeader
            title={k.subject}
            description={`${t(CATEGORY[k.category])}${k.instance ? ` · ${k.instance.name}` : ""}`}
            actions={<TicketStatusChip closed={k.status === "CLOSED"}>{t(CUSTOMER_STATUS[k.status])}</TicketStatusChip>}
          />
          <TicketThread
            messages={k.messages}
            authorLabel={(m) => (m.author === "ADMIN" ? t("Nibie Cloud team") : t("You"))}
            formatTime={(iso) => formatRelative(iso, undefined, lang)}
          />
          {k.status === "CLOSED" ? (
            <p className="text-muted-foreground">{t("This ticket is closed. Writing again reopens it.")}</p>
          ) : null}
          <TicketReply
            label={t("Your reply")}
            sendLabel={t("Send reply")}
            sendingLabel={t("Sending…")}
            pending={action.reply.isPending}
            error={error}
            onSend={(message, done) => {
              setError(null)
              action.reply.mutate(message, {
                onSuccess: () => {
                  done()
                  void ticket.refetch()
                },
                onError: (e) => setError(errorMessage(e)),
              })
            }}
          />
          {k.status !== "CLOSED" ? (
            <div className="border-t pt-4">
              <Button
                type="button"
                variant="outline"
                disabled={action.close.isPending}
                onClick={() => action.close.mutate(undefined, { onSuccess: () => void ticket.refetch(), onError: (e) => setError(errorMessage(e)) })}
              >
                {t("Close ticket")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
