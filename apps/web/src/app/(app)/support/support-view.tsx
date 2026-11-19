"use client"

import { BookOpen, Mail, Send, ShieldAlert } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { PageHeader } from "@/components/app/page-header"
import { useT } from "@/lib/i18n"
import { SUPPORT, supportEmail } from "@/lib/support"

const linkClass = "text-foreground underline underline-offset-4"

export function SupportView() {
  const t = useT()
  const email = supportEmail()
  return (
    <div className="grid gap-8">
      <PageHeader
        title={t("Support")}
        description={t("Questions about an instance, a payment or your account? Reach us here.")}
      />

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t("Contact us")}</CardTitle>
            <CardDescription>{t("Message us on Telegram or by email.")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid">
              <li className="flex flex-wrap items-center justify-between gap-3 border-t py-3 first:border-t-0 first:pt-0">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Send className="size-4" aria-hidden="true" />
                  Telegram
                </span>
                <a href={SUPPORT.telegramUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
                  {SUPPORT.telegramHandle}
                </a>
              </li>
              {email ? (
                <li className="flex flex-wrap items-center justify-between gap-3 border-t py-3">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Mail className="size-4" aria-hidden="true" />
                    {t("Email")}
                  </span>
                  <a href={`mailto:${email}`} className={`${linkClass} break-all`}>
                    {email}
                  </a>
                </li>
              ) : null}
            </ul>
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
