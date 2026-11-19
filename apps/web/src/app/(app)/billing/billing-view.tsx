"use client"

import Link from "next/link"
import { CreditCard } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/app/empty-state"
import { WalletPayButton } from "@/components/app/wallet-pay-button"
import { PageHeader } from "@/components/app/page-header"
import { PreviewNote } from "@/components/app/preview-note"
import { QueryFallback } from "@/components/app/query-fallback"
import { useApiMode, useSubscriptions } from "@/hooks/use-hermes"
import type { BillingSubscription } from "@/lib/api/types"
import { billingStatusLabel, deployAgainHref, isPendingPurchase, payableUrl, paymentText } from "@/lib/billing"
import { formatDate } from "@/lib/format"
import { useT, type T } from "@/lib/i18n"
import { startPayment } from "@/lib/pay"
import { useLang, type Lang } from "@/lib/prefs"
import { InvoicesCard } from "./invoices-card"
import { WalletCard } from "./wallet-card"

function periodText(sub: BillingSubscription, t: T, lang: Lang): string {
  if (!sub.currentPeriodEnd) return "—"
  const date = formatDate(sub.currentPeriodEnd, lang)
  if (sub.status === "ACTIVE") return sub.cancelAtPeriodEnd ? t("Ends {date}", { date }) : t("Renews {date}", { date })
  return t("Paid until {date}", { date })
}

/** An open invoice is paid here; everything else (renew, cancel) lives on the instance's Billing tab. */
function RowAction({ sub }: { sub: BillingSubscription }) {
  const t = useT()
  const url = payableUrl(sub.latestPayment)
  if (url && sub.latestPayment) {
    return (
      <div className="flex flex-wrap justify-end gap-2">
        <WalletPayButton paymentId={sub.latestPayment.id} amountIdr={sub.latestPayment.amountIdr} />
        <Button size="sm" variant="outline" onClick={() => startPayment(url)}>
          {t("Pay")}
        </Button>
      </div>
    )
  }
  // An ended order may still point at its deleted instance.
  if (sub.instanceId && sub.status !== "ENDED") {
    return (
      <Button asChild size="sm" variant="outline">
        <Link href={`/instances/${sub.instanceId}/billing`}>{t("Manage")}</Link>
      </Button>
    )
  }
  if (isPendingPurchase(sub)) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link href={deployAgainHref(sub)}>{t("Order again")}</Link>
      </Button>
    )
  }
  return null
}

export function BillingView() {
  const t = useT()
  const lang = useLang()
  const subs = useSubscriptions()
  const mock = useApiMode() === "mock"
  const list = [...(subs.data ?? [])].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  return (
    <div className="grid gap-6">
      <PageHeader
        title={t("Billing")}
        description={t("Every subscription on your account. Hosting only: AI usage is billed by NibieRouter or your own provider.")}
        actions={mock ? <PreviewNote what="Subscriptions" reason="mock" /> : null}
      />
      <WalletCard />
      <InvoicesCard />
      {!subs.data ? (
        <QueryFallback what="your subscriptions" queries={[subs]} className="h-48" />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<CreditCard aria-hidden="true" />}
          title={t("No subscriptions yet")}
          description={t("Free beta instances have nothing to pay. A paid plan shows up here after you order it.")}
          action={
            <Button asChild>
              <Link href="/deploy">{t("Deploy")}</Link>
            </Button>
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Instance")}</TableHead>
              <TableHead>{t("Plan")}</TableHead>
              <TableHead>{t("Status")}</TableHead>
              <TableHead>{t("Period")}</TableHead>
              <TableHead>{t("Latest payment")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("Actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-medium">{s.name}</TableCell>
                <TableCell>{s.planName}</TableCell>
                <TableCell>{t(billingStatusLabel(s.status, s.cancelAtPeriodEnd))}</TableCell>
                <TableCell>{periodText(s, t, lang)}</TableCell>
                <TableCell>{s.latestPayment ? paymentText(s.latestPayment, t, lang) : "—"}</TableCell>
                <TableCell className="text-right">
                  <RowAction sub={s} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <p className="max-w-[66ch] text-muted-foreground">
        {t("A missed payment starts a 3-day grace period. After that the instance is suspended and its data is kept for 30 days, then deleted.")}
      </p>
    </div>
  )
}
