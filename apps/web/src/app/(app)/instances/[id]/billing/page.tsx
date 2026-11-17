"use client"

import { useState } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { ComingSoon } from "@/components/app/coming-soon"
import { KeyValue } from "@/components/app/key-value"
import { PreviewNote } from "@/components/app/preview-note"
import { QueryFallback } from "@/components/app/query-fallback"
import { useApiMode, usePlans, useCancelRenewal, useRenew, useSubscriptions } from "@/hooks/use-hermes"
import { billingNotice, billingStatusLabel, canCancelRenewal, canRenew, subscriptionOfInstance } from "@/lib/billing"
import { formatCpu, formatDate, formatMb, formatPriceIdr } from "@/lib/format"
import { startPayment } from "@/lib/pay"
import { cn } from "@/lib/utils"
import { useInstanceId } from "../instance-frame"

export default function BillingPage() {
  const id = useInstanceId()
  const subs = useSubscriptions()
  const plans = usePlans()
  const renew = useRenew()
  const cancel = useCancelRenewal()
  const mock = useApiMode() === "mock"
  const [confirmCancel, setConfirmCancel] = useState(false)

  if (!subs.data || !plans.data) return <QueryFallback what="your subscription" queries={[subs, plans]} className="h-64" />
  const sub = subscriptionOfInstance(subs.data, id)
  if (!sub) {
    return (
      <Alert>
        <AlertTitle>Free beta instance</AlertTitle>
        <AlertDescription>This instance is on the free beta, so there is nothing to pay or renew.</AlertDescription>
      </Alert>
    )
  }
  const current = plans.data.find((p) => p.id === sub.planId)
  const late = billingNotice(sub) !== null
  const payment = sub.latestPayment

  const periodRow =
    sub.status === "ACTIVE" && !sub.cancelAtPeriodEnd
      ? { k: "Renews on", v: sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : "Not set" }
      : sub.status === "ACTIVE"
        ? { k: "Ends on", v: sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : "Not set" }
        : { k: "Paid until", v: sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : "Not set" }

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Subscription</CardTitle>
          <CardDescription>Hosting only. AI usage is billed separately by NibieRouter or your own provider.</CardDescription>
          {mock ? <PreviewNote what="Subscription" /> : null}
        </CardHeader>
        <CardContent className="grid gap-6">
          <KeyValue
            items={[
              { k: "Plan", v: sub.planName },
              { k: "Status", v: billingStatusLabel(sub.status, sub.cancelAtPeriodEnd) },
              { k: "Billing cycle", v: "Monthly (30 days)" },
              periodRow,
              ...(sub.status === "GRACE" && sub.graceEndsAt ? [{ k: "Grace ends", v: formatDate(sub.graceEndsAt) }] : []),
              ...(sub.status === "SUSPENDED" && sub.retentionEndsAt
                ? [{ k: "Data deleted on", v: formatDate(sub.retentionEndsAt) }]
                : []),
              { k: "Price", v: current ? formatPriceIdr(current.monthlyPriceIdr) : "Not available" },
              ...(payment
                ? [
                    {
                      k: "Latest payment",
                      v: `${formatPriceIdr(payment.amountIdr)} · ${
                        payment.status === "PAID" && payment.paidAt
                          ? `paid ${formatDate(payment.paidAt)}`
                          : payment.status === "PENDING"
                            ? "waiting for payment"
                            : payment.status === "FAILED"
                              ? "failed"
                              : "expired"
                      }`,
                    },
                  ]
                : []),
            ]}
          />
          <div className="grid gap-2 border-t pt-4 text-muted-foreground">
            <p>
              If a payment is missed, your instance keeps running for a 3-day grace period. After that it is suspended
              and your data is kept for 30 days, then deleted. Renewing within that window restores it.
            </p>
            <p>Cancelling stops renewal; the instance stays active until the end of the paid period.</p>
          </div>
        </CardContent>
        <CardFooter className="flex-wrap items-center gap-3 border-t">
          <Button
            variant={late ? "outline" : "default"}
            disabled={!canRenew(sub) || renew.isPending}
            onClick={() => renew.mutate(sub.id, { onSuccess: (r) => startPayment(r.payment.paymentUrl) })}
          >
            {renew.isPending ? "Preparing payment…" : "Renew now"}
          </Button>
          <Button variant="ghost" disabled={!canCancelRenewal(sub) || cancel.isPending} onClick={() => setConfirmCancel(true)}>
            Cancel renewal
          </Button>
        </CardFooter>
      </Card>

      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel renewal?</AlertDialogTitle>
            <AlertDialogDescription>
              Your instance keeps running until {sub.currentPeriodEnd ? formatDate(sub.currentPeriodEnd) : "the end of the paid period"}.
              After that it is suspended and its data is deleted after 30 days. You can renew again at any time before then.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep renewing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => cancel.mutate(sub.id)}>
              Cancel renewal
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <section className="grid gap-3" aria-labelledby="upgrade-title">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="upgrade-title" className="type-label">
            Change plan
          </h2>
          <ComingSoon />
        </div>
        <ul className="grid gap-4 md:grid-cols-3">
          {plans.data.map((p) => {
            const isCurrent = p.id === current?.id
            return (
              <li key={p.id} className={cn("grid gap-3 rounded-md border bg-card p-4", isCurrent && "border-foreground")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="type-label">{p.name}</span>
                  {isCurrent ? <span className="type-label rounded-sm border px-2 py-1 text-muted-foreground">Current</span> : null}
                </div>
                <p className="type-mono text-muted-foreground">
                  {formatCpu(p.cpuMillis)} · {formatMb(p.memoryMb)} · {formatMb(p.storageMb)}
                </p>
                <p className="text-muted-foreground">Price {formatPriceIdr(p.monthlyPriceIdr)}</p>
                {/* TODO(billing): plan switching needs payment plus a capacity check (PRD §5.5); the backend has no upgrade yet. */}
                <Button variant="outline" disabled className="mt-auto">
                  {isCurrent ? "Current plan" : "Switch plan (coming soon)"}
                </Button>
              </li>
            )
          })}
        </ul>
        <p className="text-muted-foreground">
          When plan changes arrive, an upgrade will apply after payment and a capacity check. If the new plan does not fit on
          the current node, we will schedule a migration and tell you first.
        </p>
      </section>
    </div>
  )
}
