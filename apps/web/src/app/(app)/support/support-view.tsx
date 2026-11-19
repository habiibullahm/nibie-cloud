"use client"

import Link from "next/link"
import { BookOpen, Mail, MessageCircle, Plus, ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/app/page-header"
import { QueryFallback } from "@/components/app/query-fallback"
import { TicketStatusChip } from "@/components/app/ticket-thread"
import { useSupportContact, useTickets } from "@/hooks/use-hermes"
import { formatRelative } from "@/lib/format"
import { useT } from "@/lib/i18n"
import { useLang } from "@/lib/prefs"
import { formatWhatsapp, SUPPORT, whatsappUrl } from "@/lib/support"
import { CATEGORY, CUSTOMER_STATUS } from "@/lib/ticket-labels"

const linkClass = "text-foreground underline underline-offset-4"
const rowClass = "flex flex-wrap items-center justify-between gap-3 border-t py-3 first:border-t-0 first:pt-0"

/** The customer's tickets, newest activity first. Each row opens the conversation. */
function TicketsCard() {
  const t = useT()
  const lang = useLang()
  const tickets = useTickets()
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Your tickets")}</CardTitle>
        <CardDescription>{t("Write to our team here. Replies also arrive by email.")}</CardDescription>
      </CardHeader>
      <CardContent>
        {!tickets.data ? (
          <QueryFallback what="tickets" queries={[tickets]} className="h-20 bg-elevated" />
        ) : tickets.data.length === 0 ? (
          <p className="text-muted-foreground">{t("No tickets yet.")}</p>
        ) : (
          <ul className="grid">
            {tickets.data.map((k) => (
              <li key={k.id} className={rowClass}>
                <span className="grid min-w-0 gap-1">
                  <Link href={`/support/tickets/${k.id}`} className={`${linkClass} break-words`}>
                    {k.subject}
                  </Link>
                  <span className="text-muted-foreground">
                    {t(CATEGORY[k.category])}
                    {k.instance ? ` · ${k.instance.name}` : ""} · {formatRelative(k.lastMessageAt, undefined, lang)}
                  </span>
                </span>
                <TicketStatusChip closed={k.status === "CLOSED"}>{t(CUSTOMER_STATUS[k.status])}</TicketStatusChip>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

export function SupportView() {
  const t = useT()
  const contact = useSupportContact()
  const c = contact.data
  return (
    <div className="grid gap-8">
      <PageHeader
        title={t("Support")}
        description={t("Questions about an instance, a payment or your account? Reach us here.")}
        actions={
          <Button asChild>
            <Link href="/support/tickets/new">
              <Plus aria-hidden="true" />
              {t("Open a ticket")}
            </Link>
          </Button>
        }
      />

      <TicketsCard />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t("Contact us")}</CardTitle>
            <CardDescription>{t("Message us on WhatsApp or by email.")}</CardDescription>
          </CardHeader>
          <CardContent>
            {!c ? (
              <QueryFallback what="contacts" queries={[contact]} className="h-20 bg-elevated" />
            ) : !c.whatsapp && !c.email ? (
              <p className="text-muted-foreground">{t("Support contacts are not set yet. The guides below cover the common questions.")}</p>
            ) : (
              <ul className="grid">
                {c.whatsapp ? (
                  <li className={rowClass}>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <MessageCircle className="size-4" aria-hidden="true" />
                      WhatsApp
                    </span>
                    <a href={whatsappUrl(c.whatsapp)} target="_blank" rel="noopener noreferrer" className={linkClass}>
                      {formatWhatsapp(c.whatsapp)}
                    </a>
                  </li>
                ) : null}
                {c.email ? (
                  <li className={rowClass}>
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Mail className="size-4" aria-hidden="true" />
                      {t("Email")}
                    </span>
                    <a href={`mailto:${c.email}`} className={`${linkClass} break-all`}>
                      {c.email}
                    </a>
                  </li>
                ) : null}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("Before you write")}</CardTitle>
            <CardDescription>{t("With these details we can answer in one reply.")}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <ul className="grid list-disc gap-2 pl-5">
              <li>{t("The instance name and the 8-character ID shown on its card.")}</li>
              <li>{t("What you did and what you saw. A screenshot helps.")}</li>
              <li>{t("For a payment: the order name, the amount and when you paid.")}</li>
            </ul>
            <p className="flex gap-2 border-t pt-4">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{t("Never send passwords, API keys or bot tokens. We will never ask for them.")}</span>
            </p>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("Guides")}</CardTitle>
            <CardDescription>{t("Step-by-step help for deploying, connecting Telegram and payments.")}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-x-6 gap-y-3">
            <a href={SUPPORT.docsUrl} className={`${linkClass} inline-flex items-center gap-2`}>
              <BookOpen className="size-4" aria-hidden="true" />
              {t("Read the documentation")}
            </a>
            <a href={SUPPORT.contactUrl} className={linkClass}>
              {t("Contact page")}
            </a>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
