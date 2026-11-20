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
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { PayButton, usePay } from "@/components/app/pay-button"
import {
  useApiMode,
  useInstance,
  usePlans,
  useCancelRenewal,
  useRenew,
  useSetAutoRenew,
  useSubscriptions,
  useUpgrade,
  useWallet,
} from "@/hooks/use-hermes"
import type { BillingSubscription, Plan } from "@/lib/api"
import {
  billingNotice,
  billingStatusLabel,
  canCancelRenewal,
  canRenew,
  payableUrl,
  pendingUpgradeOf,
  subscriptionOfInstance,
} from "@/lib/billing"
import { formatCpu, formatDate, formatMb, formatPriceIdr } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useInstanceId } from "../instance-frame"

export default function BillingPage() {
  const id = useInstanceId()
  const subs = useSubscriptions()
  // Poll while an upgrade's invoice can still be paid, so the page turns into the subscription once the payment lands.
  const pending = pendingUpgradeOf(subs.data, id)
  useSubscriptions(pending !== null && payableUrl(pending.latestPayment) !== null)
  const plans = usePlans()
  const instance = useInstance(id)
  const renew = useRenew()
  const cancel = useCancelRenewal()
  const wallet = useWallet().data
  const { pay, covers, paying, confirm } = usePay()
  const setAutoRenew = useSetAutoRenew()
  const mock = useApiMode() === "mock"
  const [confirmCancel, setConfirmCancel] = useState(false)

  if (!subs.data || !plans.data || !instance.data) {
    return <QueryFallback what="your subscription" queries={[subs, plans, instance]} className="h-64" />
  }
  const sub = subscriptionOfInstance(subs.data, id)
  if (!sub) {
    const own = plans.data.find((p) => p.id === instance.data.planId)
    if (own && own.monthlyPriceIdr !== null) {
      return (
        <Alert>
          <AlertTitle>No subscription</AlertTitle>
          <AlertDescription>This instance is not billed through the dashboard. Contact support with billing questions.</AlertDescription>
        </Alert>
      )
    }
    return <FreeUpgrade instanceId={id} plans={plans.data} pending={pending} />
  }
  const current = plans.data.find((p) => p.id === sub.planId)
  const renewFromBalance = covers(current?.monthlyPriceIdr)
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
        {wallet?.autoRenew && current?.monthlyPriceIdr != null && (sub.status === "ACTIVE" || sub.status === "GRACE") ? (
          <CardContent className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="grid gap-1">
              <Label htmlFor="auto-renew">Renew automatically from balance</Label>
              <p className="text-muted-foreground">
                During the last day of the period, {formatPriceIdr(current.monthlyPriceIdr)} is taken from
                your Nibie Cloud balance (now {formatPriceIdr(wallet.balanceIdr)}). If the balance is short, you get the usual
                reminders instead.
              </p>
            </div>
            <Switch
              id="auto-renew"
              checked={sub.autoRenew}
              disabled={setAutoRenew.isPending || sub.cancelAtPeriodEnd}
              onCheckedChange={(enabled) => setAutoRenew.mutate({ subscriptionId: sub.id, enabled })}
            />
          </CardContent>
        ) : null}
        <CardFooter className="flex-wrap items-center gap-3 border-t">
          {/* One button: the balance pays when it covers the price, otherwise QRIS. */}
          <Button
            variant={late ? "outline" : "default"}
            disabled={!canRenew(sub) || renew.isPending || paying}
            onClick={() => void pay({ amountIdr: current?.monthlyPriceIdr, create: async () => (await renew.mutateAsync(sub.id)).payment })}
          >
            {paying ? "Paying…" : renew.isPending ? "Preparing payment…" : renewFromBalance ? "Renew from balance" : "Renew now"}
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

      <section className="grid gap-3" aria-labelledby="change-plan-title">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="change-plan-title" className="type-label">
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
      {confirm}
    </div>
  )
}

/**
 * A free instance moves to a paid plan with one payment and keeps everything it has (agent, memory, Telegram). The
 * backend changes the plan once the payment is verified; until then this page polls and shows the open invoice.
 */
function FreeUpgrade({ instanceId, plans, pending }: { instanceId: string; plans: Plan[]; pending: BillingSubscription | null }) {
  const upgrade = useUpgrade()
  const { pay, covers, paying, confirm } = usePay()
  // One key per plan for this visit: a double click replays the same invoice, another plan is a new request.
  const [visit] = useState(() => crypto.randomUUID())
  const forSale = plans.filter((p) => p.monthlyPriceIdr !== null)
  const pendingUrl = pending ? payableUrl(pending.latestPayment) : null

  return (
    <div className="grid gap-6">
      <Alert>
        <AlertTitle>Free beta instance</AlertTitle>
        <AlertDescription>
          This instance is on the free beta. Upgrade to a paid plan to keep it running after the beta, with everything it
          already has: your agent, its memory and your Telegram bot.
        </AlertDescription>
      </Alert>

      {pending ? (
        <Alert>
          <AlertTitle>Upgrade to {pending.planName} is waiting for payment</AlertTitle>
          <AlertDescription>
            <p>
              {pendingUrl
                ? "Finish the payment to apply the new plan. This page updates by itself once it is paid."
                : "The invoice expired. Choose a plan below to get a new one."}
            </p>
            {pendingUrl && pending?.latestPayment ? (
              <div className="mt-2">
                <PayButton payment={pending.latestPayment} label="Continue payment" />
              </div>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="grid gap-3" aria-labelledby="upgrade-title">
        <h2 id="upgrade-title" className="type-label">
          Upgrade to a paid plan
        </h2>
        {forSale.length === 0 ? (
          <p className="text-muted-foreground">No paid plan is for sale right now.</p>
        ) : (
          <ul className="grid gap-4 md:grid-cols-3">
            {forSale.map((p) => (
              <li key={p.id} className="grid gap-3 rounded-md border bg-card p-4">
                <span className="type-label">{p.name}</span>
                <p className="type-mono text-muted-foreground">
                  {formatCpu(p.cpuMillis)} · {formatMb(p.memoryMb)} · {formatMb(p.storageMb)}
                </p>
                <p className="text-muted-foreground">
                  {formatPriceIdr(p.monthlyPriceIdr)} per 30 days
                  {p.includedCreditUsd ? ` · includes US$${p.includedCreditUsd} AI credit` : ""}
                </p>
                <Button
                  variant="outline"
                  className="mt-auto"
                  disabled={!p.available || upgrade.isPending || paying}
                  onClick={() =>
                    void pay({
                      amountIdr: p.monthlyPriceIdr,
                      create: async () => (await upgrade.mutateAsync({ instanceId, planId: p.id, idempotencyKey: `${visit}:${p.id}` })).payment,
                    })
                  }
                >
                  {!p.available
                    ? "Not available yet"
                    : (upgrade.isPending || paying) && upgrade.variables?.planId === p.id
                      ? "Preparing payment…"
                      : covers(p.monthlyPriceIdr)
                        ? `Upgrade to ${p.name} from balance`
                        : `Upgrade to ${p.name}`}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground">
          The price is taken from your Nibie Cloud balance when it covers it, otherwise you pay by QRIS on the SumoPod page.
          After the payment, the instance restarts once to apply the new plan.
        </p>
      </section>
      {confirm}
    </div>
  )
}
