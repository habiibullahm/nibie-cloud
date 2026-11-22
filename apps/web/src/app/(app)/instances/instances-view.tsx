"use client"

import Link from "next/link"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useState, useSyncExternalStore } from "react"
import { Boxes, CircleCheck, Clock, Plus, RefreshCw, TriangleAlert } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/app/empty-state"
import { PageHeader } from "@/components/app/page-header"
import { PreviewNote } from "@/components/app/preview-note"
import { StatusBadge } from "@/components/app/status-badge"
import { errorMessage, keys, useApiMode, useInstanceMeta, useInstances, usePlans, useSubscriptions } from "@/hooks/use-hermes"
import type { BillingSubscription, Instance } from "@/lib/api/types"
import {
  deployAgainHref,
  evaluateReturn,
  isPendingPurchase,
  isRenewal,
  newestOrder,
  payableUrl,
  retryHref,
  subscriptionOfInstance,
} from "@/lib/billing"
import { useT } from "@/lib/i18n"
import { arrangeInstances, countByGroup, GROUPS, SORTS, type InstanceGroup, type InstanceSort } from "@/lib/instance-list"
import { PayButton } from "@/components/app/pay-button"
import { useLang } from "@/lib/prefs"
import { presentStatus } from "@/lib/api/status"
import { formatPriceIdr, formatRelative, shortId } from "@/lib/format"
import { cn } from "@/lib/utils"

const RETURN_POLL_MS = 5 * 60_000

/** True when the payment gateway sent the customer back here (`?payment=<order id>`, see backend returnUrl). */
function useReturnedFromPayment(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => new URLSearchParams(window.location.search).has("payment"),
    () => false
  )
}

export function InstancesView() {
  const t = useT()
  const { data, isLoading, error, refetch, isFetching } = useInstances()
  const mock = useApiMode() === "mock"
  const qc = useQueryClient()
  // Latched: the `?payment=` query is dropped once the outcome is known, but the alert stays for this visit.
  const returnedNow = useReturnedFromPayment()
  const [returned, setReturned] = useState(false)
  if (returnedNow && !returned) setReturned(true)
  const [since] = useState(() => Date.now())
  const [waitingTooLong, setWaitingTooLong] = useState(false)
  const [group, setGroup] = useState<InstanceGroup>("all")
  const [sort, setSort] = useState<InstanceSort>("active")
  const subs = useSubscriptions()
  const returnState = returned && subs.data ? evaluateReturn(subs.data) : null
  const newest = subs.data ? newestOrder(subs.data) : null
  // Poll while the callback is on its way, and after "paid" until the new instance exists.
  useSubscriptions(returned && !waitingTooLong && !(returnState === "paid" && newest?.instanceId))
  const purchases = subs.data?.filter(isPendingPurchase) ?? []
  const payable = purchases.filter((s) => payableUrl(s.latestPayment) !== null)
  const expired = purchases.filter((s) => payableUrl(s.latestPayment) === null)

  // The callback is asynchronous: keep polling for a few minutes, then stop and say so.
  useEffect(() => {
    if (returnState !== "waiting") return
    const timer = setTimeout(() => setWaitingTooLong(true), Math.max(0, RETURN_POLL_MS - (Date.now() - since)))
    return () => clearTimeout(timer)
  }, [returnState, since])
  // Once the purchase is paid the backend creates the instance: pick it up.
  const newInstanceId = newest?.instanceId
  useEffect(() => {
    if (returnState === "paid") void qc.invalidateQueries({ queryKey: keys.instances })
  }, [returnState, newInstanceId, qc])
  // A final outcome must not come back on reload or from a bookmark.
  useEffect(() => {
    if (returnedNow && (returnState === "paid" || returnState === "failed")) {
      window.history.replaceState(null, "", window.location.pathname)
    }
  }, [returnedNow, returnState])

  const showInstances = !(data && data.length === 0 && payable.length > 0)
  const shown = data ? arrangeInstances(data, group, sort) : []

  return (
    <div className="grid gap-8">
      <PageHeader
        title={t("Instances")}
        description={t("Each instance is a dedicated Hermes runtime with its own persistent storage.")}
        actions={
          <>
            {mock ? <PreviewNote what="These instances" reason="mock" /> : null}
            {/* While a purchase can still be paid, "Pay now" is the screen's primary action. */}
            <Button asChild variant={payable.length > 0 ? "outline" : "default"}>
              <Link href="/deploy">
                <Plus aria-hidden="true" />
                {t("Deploy instance")}
              </Link>
            </Button>
          </>
        }
      />

      {returnState ? <PaymentReturn state={returnState} timedOut={waitingTooLong} order={newest} /> : null}

      {payable.length > 0 ? (
        <section className="grid gap-3" aria-labelledby="pending-title">
          <h2 id="pending-title" className="type-label">
            {t("Awaiting payment")}
          </h2>
          <ul className="grid gap-4 md:grid-cols-2">
            {payable.map((p) => (
              <li key={p.id}>
                <PendingPurchaseCard sub={p} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {showInstances ? (
        <section className="grid gap-3" aria-labelledby="instances-title">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="instances-title" className="type-label">
              {t("Your instances")}
            </h2>
            {data && data.length > 1 ? <ListControls list={data} group={group} sort={sort} onGroup={setGroup} onSort={setSort} /> : null}
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>{t("Could not load instances")}</AlertTitle>
              <AlertDescription>
                <p>{errorMessage(error)}</p>
                <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
                  <RefreshCw aria-hidden="true" />
                  {t("Try again")}
                </Button>
              </AlertDescription>
            </Alert>
          ) : isLoading ? (
            <div className="grid gap-4 md:grid-cols-2" role="status" aria-label={t("Loading instances")}>
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-40 rounded-md bg-card" />
              ))}
            </div>
          ) : data && data.length === 0 ? (
            <EmptyState
              icon={<Boxes />}
              title={t("No instances yet")}
              description={t(
                "Pick a plan and a name. Nibie Cloud runs the container, keeps its storage and restarts it if it crashes."
              )}
              action={
                <Button asChild variant="outline">
                  <Link href="/deploy">{t("Deploy your first instance")}</Link>
                </Button>
              }
            />
          ) : shown.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed bg-card p-4">
              <p className="text-muted-foreground">{t("No instances match this filter.")}</p>
              <Button size="sm" variant="outline" onClick={() => setGroup("all")}>
                {t("Show all")}
              </Button>
            </div>
          ) : (
            <ul className="grid gap-4 md:grid-cols-2" aria-labelledby="instances-title">
              {shown.map((i) => (
                <li key={i.id}>
                  <InstanceCard instance={i} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {expired.length > 0 ? <ExpiredOrders orders={expired} /> : null}
    </div>
  )
}

/** Status filter (groups with no instances are left out) and sort order; "Active first" is the default. */
function ListControls({
  list,
  group,
  sort,
  onGroup,
  onSort,
}: {
  list: Instance[]
  group: InstanceGroup
  sort: InstanceSort
  onGroup: (g: InstanceGroup) => void
  onSort: (s: InstanceSort) => void
}) {
  const t = useT()
  const counts = countByGroup(list)
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div role="group" aria-label={t("Filter by status")} className="flex flex-wrap gap-1">
        {GROUPS.filter((g) => g.value === "all" || g.value === group || counts[g.value] > 0).map((g) => (
          <button
            key={g.value}
            type="button"
            aria-pressed={group === g.value}
            onClick={() => onGroup(g.value)}
            className={cn(
              "hit-area relative rounded-sm border border-transparent px-2 py-1 text-muted-foreground outline-none transition-colors hover:bg-card hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              group === g.value && "border-input bg-card text-foreground"
            )}
          >
            {t(g.label)} <span className="type-mono">{counts[g.value]}</span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span id="sort-label" className="text-muted-foreground">
          {t("Sort")}
        </span>
        <Select value={sort} onValueChange={(v) => onSort(v as InstanceSort)}>
          <SelectTrigger size="sm" aria-labelledby="sort-label" className="w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {t(s.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

function InstanceCard({ instance }: { instance: Instance }) {
  const t = useT()
  const lang = useLang()
  const meta = useInstanceMeta(instance.id)
  const plans = usePlans()
  const customer = useApiMode() === "customer"
  const subs = useSubscriptions()
  // The billed plan wins, then the instance's own plan. Sample meta (region, runtime) is not shown to customers.
  const billedPlanId = subscriptionOfInstance(subs.data, instance.id)?.planId
  const plan = plans.data?.find((p) => p.id === (billedPlanId ?? instance.planId))
  const p = presentStatus(instance.status)
  const reason = instance.statusReason ?? (p.tone === "ok" ? null : p.defaultReason)

  return (
    <article className="relative flex h-full flex-col gap-3 rounded-md border bg-card p-4 transition-colors focus-within:border-muted-foreground hover:border-muted-foreground">
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 break-words text-foreground">
          <Link
            href={`/instances/${instance.id}`}
            className="rounded-sm text-foreground no-underline outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-offset-2 focus-visible:after:ring-offset-background"
          >
            {instance.name}
          </Link>
        </h3>
        <StatusBadge status={instance.status} />
      </div>
      <p className="type-mono text-muted-foreground">
        {shortId(instance.id)}
        {plan ? ` · ${plan.name}` : ""}
        {meta.data && !customer ? ` · ${meta.data.regionId}` : ""}
        {meta.data && !customer ? ` · ${meta.data.runtime}` : ""}
      </p>
      {/* A backend statusReason is English; only the default reasons have translations. */}
      {reason ? <p className="text-muted-foreground">{t(reason)}</p> : null}
      <div className="mt-auto flex items-center justify-between gap-3 border-t pt-3 text-muted-foreground">
        <span>{t("Created {when}", { when: formatRelative(instance.createdAt, undefined, lang) })}</span>
        <span className="text-foreground underline decoration-input underline-offset-4" aria-hidden="true">
          {t("Manage")}
        </span>
      </div>
    </article>
  )
}

function PaymentReturn({
  state,
  timedOut,
  order,
}: {
  state: "waiting" | "paid" | "failed"
  timedOut: boolean
  order: BillingSubscription | null
}) {
  const t = useT()
  const renewal = isRenewal(order)
  if (state === "paid") {
    return (
      <Alert>
        <CircleCheck aria-hidden="true" />
        <AlertTitle>{t("Payment received")}</AlertTitle>
        <AlertDescription>
          {order?.instanceId ? (
            <>
              <p>
                {renewal
                  ? t("Thank you. {name} is renewed.", { name: order.name })
                  : t("Thank you. {name} is being created. Open it to follow the deployment and connect Telegram.", { name: order.name })}
              </p>
              <Button asChild size="sm" variant="outline">
                <Link href={`/instances/${order.instanceId}`}>{t("Open {name}", { name: order.name })}</Link>
              </Button>
            </>
          ) : (
            <p>{t("Thank you. Your instance is being created and will appear below in a moment.")}</p>
          )}
        </AlertDescription>
      </Alert>
    )
  }
  if (state === "failed") {
    return (
      <Alert variant="destructive">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>{t("Payment not completed")}</AlertTitle>
        <AlertDescription>
          <p>
            {renewal && order
              ? t("The payment failed or expired, so nothing was charged and {name} was not renewed.", { name: order.name })
              : t("The payment failed or expired, so nothing was charged and no instance was created.")}
          </p>
          <Button asChild size="sm" variant="outline">
            <Link href={order ? retryHref(order) : "/deploy"}>{renewal ? t("Try the renewal again") : t("Deploy again")}</Link>
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert>
      <Clock aria-hidden="true" />
      <AlertTitle>{timedOut ? t("Still waiting for the payment confirmation") : t("Waiting for your payment")}</AlertTitle>
      <AlertDescription>
        {timedOut
          ? t(
              "We have not heard from the payment provider yet. If you paid, it can take a few more minutes: reload this page later. Your money is safe either way."
            )
          : t("This page updates by itself as soon as the payment is confirmed. Bank transfers can take a minute.")}
      </AlertDescription>
    </Alert>
  )
}

/** An order that can still be paid. Expired ones are listed by ExpiredOrders instead. */
function PendingPurchaseCard({ sub }: { sub: BillingSubscription }) {
  const t = useT()
  const lang = useLang()
  const url = payableUrl(sub.latestPayment)
  return (
    <article className="flex h-full flex-col gap-3 rounded-md border bg-card p-4">
      <h3 className="min-w-0 break-words text-foreground">{sub.name}</h3>
      <p className="type-mono text-muted-foreground">
        {sub.planName}
        {sub.latestPayment ? ` · ${formatPriceIdr(sub.latestPayment.amountIdr, lang)}` : ""}
      </p>
      <p className="text-muted-foreground">{t("The instance is created as soon as the payment is confirmed.")}</p>
      {url && sub.latestPayment ? (
        <div className="mt-auto flex items-center gap-3 border-t pt-3">
          <PayButton payment={sub.latestPayment} label={t("Pay now")} purpose={sub.name} qrisOnly variant="default" />
        </div>
      ) : null}
    </article>
  )
}

/** Unpaid orders whose link expired. The backend ends them 7 days after they were made (billing-tick ABANDONED_AFTER_DAYS). */
function ExpiredOrders({ orders }: { orders: BillingSubscription[] }) {
  const t = useT()
  const lang = useLang()
  return (
    <section className="grid gap-3" aria-labelledby="expired-title">
      <div className="grid gap-1">
        <h2 id="expired-title" className="type-label">
          {t("Expired orders")}
        </h2>
        <p className="text-muted-foreground">
          {t(
            "These orders were not paid in time, so nothing was charged and no instance was created. Each one disappears 7 days after it was made."
          )}
        </p>
      </div>
      <ul className="grid rounded-md border bg-card">
        {orders.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 first:border-t-0">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="min-w-0 break-words text-foreground">{s.name}</span>
              <span className="type-mono text-muted-foreground">
                {s.planName}
                {s.latestPayment ? ` · ${formatPriceIdr(s.latestPayment.amountIdr, lang)}` : ""}
              </span>
            </span>
            <Button asChild size="sm" variant="outline">
              <Link href={deployAgainHref(s)}>
                {t("Deploy again")}
                <span className="sr-only">: {s.name}</span>
              </Link>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
