"use client"

import { CalendarClock } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { ComingSoon } from "@/components/app/coming-soon"
import { KeyValue } from "@/components/app/key-value"
import { PreviewNote } from "@/components/app/preview-note"
import { QueryFallback } from "@/components/app/query-fallback"
import { usePlans, useSubscription } from "@/hooks/use-hermes"
import type { SubscriptionState } from "@/lib/api/types"
import { formatCpu, formatDate, formatMb, formatPriceIdr } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useInstanceId } from "../instance-frame"

const STATE: Record<SubscriptionState, string> = {
  active: "Active",
  cancel_scheduled: "Cancels at period end",
  grace: "Payment overdue (grace period)",
  suspended: "Suspended",
  expired: "Expired",
}

export default function BillingPage() {
  const id = useInstanceId()
  const sub = useSubscription(id)
  const plans = usePlans()
  if (!sub.data || !plans.data) return <QueryFallback what="your subscription" queries={[sub, plans]} className="h-64" />
  const current = plans.data.find((p) => p.id === sub.data.planId)

  return (
    <div className="grid gap-6">
      <Alert>
        <CalendarClock aria-hidden="true" />
        <AlertTitle>Billing is not live yet</AlertTitle>
        <AlertDescription>
          Pricing is still being set, so renewals, upgrades and cancellation are shown but cannot be completed.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>Subscription</CardTitle>
          <CardDescription>Hosting only. AI usage is billed separately by your provider.</CardDescription>
          <CardAction>
            <PreviewNote what="Subscription" />
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-6">
          <KeyValue
            items={[
              { k: "Plan", v: current?.name ?? "Unknown plan" },
              { k: "Status", v: STATE[sub.data.state] },
              { k: "Billing cycle", v: "Monthly" },
              { k: "Renews on", v: formatDate(sub.data.currentPeriodEnd) },
              { k: "Price", v: formatPriceIdr(current?.monthlyPriceIdr ?? null) },
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
        {/* TODO(billing): wire renew and cancel to the payment gateway (PRD §5.4). */}
        <CardFooter className="flex-wrap items-center gap-3 border-t">
          <Button disabled>Renew now</Button>
          <Button variant="ghost" disabled>
            Cancel subscription
          </Button>
          <ComingSoon />
        </CardFooter>
      </Card>

      <section className="grid gap-3" aria-labelledby="upgrade-title">
        <h2 id="upgrade-title" className="type-label">
          Change plan
        </h2>
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
                {/* TODO(billing): plan switching needs payment plus a capacity check (PRD §5.5). */}
                <Button variant="outline" disabled className="mt-auto">
                  {isCurrent ? "Current plan" : "Switch plan (coming soon)"}
                </Button>
              </li>
            )
          })}
        </ul>
        <p className="text-muted-foreground">
          Upgrades apply after payment and a capacity check. If your plan does not fit on the current node, we schedule a
          migration and tell you first.
        </p>
      </section>
    </div>
  )
}
