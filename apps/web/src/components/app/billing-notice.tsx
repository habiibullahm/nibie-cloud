"use client"

import Link from "next/link"
import { Clock, TriangleAlert } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { usePlans, useRenew, useSubscriptions } from "@/hooks/use-hermes"
import type { BillingSubscription } from "@/lib/api"
import { billingNotice, payableUrl, subscriptionOfInstance } from "@/lib/billing"
import { useT } from "@/lib/i18n"
import { useLang } from "@/lib/prefs"
import { usePay } from "./pay-button"

/**
 * Shown on every instance page while payment is late: grace (still running) or suspended (stopped, scheduled
 * for deletion). Icon, title and dates carry the meaning; the one primary action is "Renew now".
 */
export function BillingNotice({ instanceId }: { instanceId: string }) {
  const t = useT()
  const lang = useLang()
  const subs = useSubscriptions()
  const sub = subscriptionOfInstance(subs.data, instanceId)
  const notice = billingNotice(sub, t, lang)
  if (!sub || !notice) return null
  const suspended = notice.kind === "suspended"
  const Icon = suspended ? TriangleAlert : Clock

  return (
    <Alert variant={suspended ? "destructive" : "default"} aria-labelledby="billing-notice-title">
      <Icon aria-hidden="true" />
      <AlertTitle id="billing-notice-title">
        {notice.title}
      </AlertTitle>
      <AlertDescription>
        <p>{notice.body}</p>
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <RenewButton sub={sub} label={notice.renewLabel} />
          <Button asChild variant="outline" size="sm">
            <Link href={`/instances/${instanceId}/billing`}>{t("Billing details")}</Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

function RenewButton({ sub, label }: { sub: BillingSubscription; label: string }) {
  const t = useT()
  const plans = usePlans()
  const renew = useRenew()
  const { pay, paying, confirm } = usePay()
  const open = sub.latestPayment?.purpose === "RENEWAL" && payableUrl(sub.latestPayment) ? sub.latestPayment : null
  const amountIdr = open?.amountIdr ?? plans.data?.find((p) => p.id === sub.planId)?.monthlyPriceIdr

  return (
    <>
      <Button size="sm" disabled={paying} onClick={() => pay({
        amountIdr,
        qrisOnly: true,
        purpose: t("Renew {name}", { name: sub.name }),
        create: async () => (await renew.mutateAsync(sub.id)).payment,
      })}>
        {paying ? t("Preparing payment…") : label}
      </Button>
      {confirm}
    </>
  )
}
