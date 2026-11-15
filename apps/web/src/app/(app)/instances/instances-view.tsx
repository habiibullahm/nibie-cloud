"use client"

import Link from "next/link"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useState, useSyncExternalStore } from "react"
import { Boxes, CircleCheck, Clock, Plus, RefreshCw, TriangleAlert } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/app/empty-state"
import { PageHeader } from "@/components/app/page-header"
import { PreviewNote } from "@/components/app/preview-note"
import { StatusBadge } from "@/components/app/status-badge"
import { errorMessage, keys, useApiMode, useInstanceMeta, useInstances, usePlans, useSubscriptions } from "@/hooks/use-hermes"
import type { BillingSubscription, Instance } from "@/lib/api/types"
import { evaluateReturn, isPendingPurchase, payableUrl } from "@/lib/billing"
import { startPayment } from "@/lib/pay"
import { presentStatus } from "@/lib/api/status"
import { formatPriceIdr, formatRelative, shortId } from "@/lib/format"

const RETURN_POLL_MS = 5 * 60_000

/** True when Duitku sent the customer back here (`?payment=<order id>`, see backend returnUrl). */
function useReturnedFromPayment(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => new URLSearchParams(window.location.search).has("payment"),
    () => false
  )
}

export function InstancesView() {
  const { data, isLoading, error, refetch, isFetching } = useInstances()
  const mock = useApiMode() === "mock"
  const qc = useQueryClient()
  const returned = useReturnedFromPayment()
  const [since] = useState(() => Date.now())
  const [waitingTooLong, setWaitingTooLong] = useState(false)
  const subs = useSubscriptions(returned && !waitingTooLong)
  const pending = subs.data?.filter(isPendingPurchase) ?? []
  const returnState = returned && subs.data ? evaluateReturn(subs.data) : null

  // The callback is asynchronous: keep polling for a few minutes, then stop and say so.
  useEffect(() => {
    if (returnState !== "waiting") return
    const t = setTimeout(() => setWaitingTooLong(true), Math.max(0, RETURN_POLL_MS - (Date.now() - since)))
    return () => clearTimeout(t)
  }, [returnState, since])
  // Once the purchase is no longer pending the backend is creating the instance: pick it up.
  useEffect(() => {
    if (returnState === "paid") void qc.invalidateQueries({ queryKey: keys.instances })
  }, [returnState, qc])

  return (
    <div className="grid gap-8">
      <PageHeader
        title="Instances"
        description="Each instance is a dedicated Hermes runtime with its own persistent storage."
        actions={
          <>
            {mock ? <PreviewNote what="These instances" reason="mock" /> : null}
            <Button asChild>
              <Link href="/deploy">
                <Plus aria-hidden="true" />
                Deploy instance
              </Link>
            </Button>
          </>
        }
      />

      {returnState ? <PaymentReturn state={returnState} timedOut={waitingTooLong} /> : null}

      {pending.length > 0 ? (
        <section className="grid gap-3" aria-labelledby="pending-title">
          <h2 id="pending-title" className="type-label">
            Awaiting payment
          </h2>
          <ul className="grid gap-4 md:grid-cols-2">
            {pending.map((p) => (
              <li key={p.id}>
                <PendingPurchaseCard sub={p} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load instances</AlertTitle>
          <AlertDescription>
            <p>{errorMessage(error)}</p>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw aria-hidden="true" />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : isLoading ? (
        <div className="grid gap-4 md:grid-cols-2" role="status" aria-label="Loading instances">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-40 rounded-md bg-card" />
          ))}
        </div>
      ) : data && data.length === 0 && pending.length > 0 ? null : data && data.length === 0 ? (
        <EmptyState
          icon={<Boxes />}
          title="No instances yet"
          description="Deploy your first Hermes agent. Choose a plan and region, name it, and we handle the runtime, storage and recovery."
          action={
            <Button asChild variant="outline">
              <Link href="/deploy">Start a deployment</Link>
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" aria-label="Your instances">
          {data?.map((i) => (
            <li key={i.id}>
              <InstanceCard instance={i} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function InstanceCard({ instance }: { instance: Instance }) {
  const meta = useInstanceMeta(instance.id)
  const plans = usePlans()
  const plan = plans.data?.find((p) => p.id === meta.data?.planId)
  const p = presentStatus(instance.status)
  const reason = instance.statusReason ?? (p.tone === "ok" ? null : p.defaultReason)

  return (
    <article className="relative flex h-full flex-col gap-3 rounded-md border bg-card p-4 transition-colors focus-within:border-muted-foreground hover:border-muted-foreground">
      <div className="flex items-center justify-between gap-3">
        <span className="type-label text-muted-foreground">Instance</span>
        <StatusBadge status={instance.status} />
      </div>
      <h2 className="min-w-0 break-words text-foreground">
        <Link
          href={`/instances/${instance.id}`}
          className="rounded-sm text-foreground no-underline outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-offset-2 focus-visible:after:ring-offset-background"
        >
          {instance.name}
        </Link>
      </h2>
      <p className="type-mono text-muted-foreground">
        {shortId(instance.id)}
        {plan ? ` · ${plan.name.toLowerCase()}` : ""}
        {meta.data ? ` · ${meta.data.regionId}` : ""}
        {meta.data ? ` · ${meta.data.runtime}` : ""}
      </p>
      {reason ? <p className="text-muted-foreground">{reason}</p> : null}
      <div className="mt-auto flex items-center justify-between gap-3 border-t pt-3 text-muted-foreground">
        <span>Created {formatRelative(instance.createdAt)}</span>
        <span className="text-foreground underline decoration-input underline-offset-4" aria-hidden="true">
          Manage
        </span>
      </div>
    </article>
  )
}

function PaymentReturn({ state, timedOut }: { state: "waiting" | "paid" | "failed"; timedOut: boolean }) {
  if (state === "paid") {
    return (
      <Alert>
        <CircleCheck aria-hidden="true" />
        <AlertTitle>Payment received</AlertTitle>
        <AlertDescription>Thank you. Your instance is being created and will appear below in a moment.</AlertDescription>
      </Alert>
    )
  }
  if (state === "failed") {
    return (
      <Alert variant="destructive">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Payment not completed</AlertTitle>
        <AlertDescription>
          <p>The payment failed or expired, so nothing was charged and no instance was created.</p>
          <Button asChild size="sm" variant="outline">
            <Link href="/deploy">Start a new payment</Link>
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert>
      <Clock aria-hidden="true" />
      <AlertTitle>{timedOut ? "Still waiting for the payment confirmation" : "Waiting for your payment"}</AlertTitle>
      <AlertDescription>
        {timedOut
          ? "We have not heard from the payment provider yet. If you paid, it can take a few more minutes: reload this page later. Your money is safe either way."
          : "This page updates by itself as soon as the payment is confirmed. Bank transfers can take a minute."}
      </AlertDescription>
    </Alert>
  )
}

function PendingPurchaseCard({ sub }: { sub: BillingSubscription }) {
  const url = payableUrl(sub.latestPayment)
  return (
    <article className="flex h-full flex-col gap-3 rounded-md border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="type-label text-muted-foreground">New instance</span>
        <span className="type-label rounded-sm border px-2 py-1 text-muted-foreground">Awaiting payment</span>
      </div>
      <h3 className="min-w-0 break-words text-foreground">{sub.name}</h3>
      <p className="type-mono text-muted-foreground">
        {sub.planName}
        {sub.latestPayment ? ` · ${formatPriceIdr(sub.latestPayment.amountIdr)}` : ""}
      </p>
      <p className="text-muted-foreground">
        {url ? "The instance is created as soon as the payment is confirmed." : "This invoice has expired, so it can no longer be paid."}
      </p>
      <div className="mt-auto flex items-center gap-3 border-t pt-3">
        {url ? (
          <Button size="sm" onClick={() => startPayment(url)}>
            Pay now
          </Button>
        ) : (
          <Button asChild size="sm" variant="outline">
            <Link href="/deploy">Start a new payment</Link>
          </Button>
        )}
      </div>
    </article>
  )
}
