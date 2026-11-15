"use client"

import Link from "next/link"
import { Clock, TriangleAlert } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useRenew, useSubscriptions } from "@/hooks/use-hermes"
import { billingNotice, subscriptionOfInstance } from "@/lib/billing"
import { startPayment } from "@/lib/pay"

/**
 * Shown on every instance page while payment is late: grace (still running) or suspended (stopped, scheduled
 * for deletion). Icon, title and dates carry the meaning; the one primary action is "Renew now".
 */
export function BillingNotice({ instanceId }: { instanceId: string }) {
  const subs = useSubscriptions()
  const renew = useRenew()
  const sub = subscriptionOfInstance(subs.data, instanceId)
  const notice = billingNotice(sub)
  if (!sub || !notice) return null
  const suspended = notice.kind === "suspended"
  const Icon = suspended ? TriangleAlert : Clock

  return (
    <Alert variant={suspended ? "destructive" : "default"} aria-labelledby="billing-notice-title">
      <Icon aria-hidden="true" />
      <AlertTitle id="billing-notice-title" className="line-clamp-none">
        {notice.title}
      </AlertTitle>
      <AlertDescription>
        <p>{notice.body}</p>
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <Button
            size="sm"
            disabled={renew.isPending}
            onClick={() => renew.mutate(sub.id, { onSuccess: (r) => startPayment(r.payment.paymentUrl) })}
          >
            {renew.isPending ? "Preparing payment…" : notice.renewLabel}
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`/instances/${instanceId}/billing`}>Billing details</Link>
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}
