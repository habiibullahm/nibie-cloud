import type { BillingPayment, BillingStatus, BillingSubscription } from "./api/types"
import { formatDate } from "./format"

/** Plain-language status for a subscription. Always text, never only a color (DESIGN.md). */
export function billingStatusLabel(status: BillingStatus, cancelAtPeriodEnd: boolean): string {
  if (status === "ACTIVE" && cancelAtPeriodEnd) return "Active, renewal cancelled"
  switch (status) {
    case "PENDING_PAYMENT":
      return "Awaiting payment"
    case "ACTIVE":
      return "Active"
    case "GRACE":
      return "Payment overdue (grace period)"
    case "SUSPENDED":
      return "Suspended"
    case "ENDED":
      return "Ended"
  }
}

/** The SumoPod payment page, only while the invoice can still be paid. */
export function payableUrl(payment: BillingPayment | null, now = Date.now()): string | null {
  if (!payment || payment.status !== "PENDING" || !payment.paymentUrl) return null
  return new Date(payment.expiresAt).getTime() > now ? payment.paymentUrl : null
}

/** A purchase the customer started but has not paid: there is no instance yet. */
export function isPendingPurchase(sub: BillingSubscription): boolean {
  return sub.status === "PENDING_PAYMENT" && sub.instanceId === null
}

/** The subscription that bills an instance. An unpaid upgrade (see `pendingUpgradeOf`) does not count until it is paid. */
export function subscriptionOfInstance(subs: BillingSubscription[] | undefined, instanceId: string) {
  return subs?.find((s) => s.instanceId === instanceId && s.status !== "PENDING_PAYMENT") ?? null
}

/** An upgrade of a free instance that waits for its first payment. */
export function pendingUpgradeOf(subs: BillingSubscription[] | undefined, instanceId: string) {
  return subs?.find((s) => s.instanceId === instanceId && s.status === "PENDING_PAYMENT") ?? null
}

/** Renewal is offered while the subscription is running, late, or suspended (backend `renew` rules). */
export function canRenew(sub: BillingSubscription): boolean {
  return sub.status === "ACTIVE" || sub.status === "GRACE" || sub.status === "SUSPENDED"
}

export function canCancelRenewal(sub: BillingSubscription): boolean {
  return (sub.status === "ACTIVE" || sub.status === "GRACE" || sub.status === "SUSPENDED") && !sub.cancelAtPeriodEnd
}

export interface BillingNotice {
  kind: "grace" | "suspended"
  title: string
  body: string
  renewLabel: string
}

/**
 * The banner shown on every instance page when payment is late. Only grace and suspension need one;
 * a healthy subscription shows nothing. Dates come from the backend (PRD 10.1: 3 days grace, 30 days retention).
 */
export function billingNotice(sub: BillingSubscription | null): BillingNotice | null {
  if (!sub) return null
  if (sub.status === "GRACE") {
    const until = sub.graceEndsAt ? ` until ${formatDate(sub.graceEndsAt)}` : ""
    return {
      kind: "grace",
      title: "Payment overdue",
      body: `Your instance keeps running${until}. Renew before then, or it will be stopped.`,
      renewLabel: "Renew now",
    }
  }
  if (sub.status === "SUSPENDED") {
    const keep = sub.retentionEndsAt
      ? `Its data is kept until ${formatDate(sub.retentionEndsAt)}, then permanently deleted.`
      : "Its data is kept for a limited time, then permanently deleted."
    return {
      kind: "suspended",
      title: "Instance suspended, scheduled for deletion",
      body: `Your instance is stopped. ${keep} Renew to reactivate it.`,
      renewLabel: "Renew now to prevent deletion",
    }
  }
  return null
}

export type ReturnState = "waiting" | "paid" | "failed"

/** The subscription with the most recently issued invoice (latest expiresAt); see evaluateReturn. */
export function newestOrder(subs: BillingSubscription[]): (BillingSubscription & { latestPayment: BillingPayment }) | null {
  let best: (BillingSubscription & { latestPayment: BillingPayment }) | null = null
  for (const s of subs) {
    const p = s.latestPayment
    if (p && (!best || Date.parse(p.expiresAt) > Date.parse(best.latestPayment.expiresAt))) best = { ...s, latestPayment: p }
  }
  return best
}

/** The Deploy form prefilled with an unpaid order's name and plan, so a retry does not start from an empty form. */
export function deployAgainHref(sub: Pick<BillingSubscription, "name" | "planId">): string {
  return `/deploy?${new URLSearchParams({ name: sub.name, plan: sub.planId })}`
}

/** A renewal pays for an existing instance; the gateway returns to the same page for new orders and renewals. */
export function isRenewal(order: BillingSubscription | null): boolean {
  return order?.latestPayment?.purpose === "RENEWAL" && order.instanceId !== null
}

/**
 * Where to try again after a payment that did not go through: a renewal or an upgrade on its instance's billing page, a
 * new order on Deploy.
 */
export function retryHref(order: BillingSubscription): string {
  return order.instanceId !== null ? `/instances/${order.instanceId}/billing` : deployAgainHref(order)
}

/**
 * After the gateway sends the customer back, the backend callback may still be on its way. Judge only
 * the most recently issued invoice (the one the customer just returned from), so older abandoned
 * purchases with expired invoices do not turn a successful payment into "failed".
 * shortcut: "most recent" is the latest expiresAt (issue time + fixed expiry) because the customer API
 * does not expose the merchant order id from `?payment=`; match on that id if it is ever exposed.
 */
export function evaluateReturn(subs: BillingSubscription[], now = Date.now()): ReturnState {
  const latest = newestOrder(subs)?.latestPayment
  if (!latest) return subs.some(isPendingPurchase) ? "failed" : "paid"
  if (latest.status === "PAID") return "paid"
  if (latest.status === "PENDING" && Date.parse(latest.expiresAt) > now) return "waiting"
  return "failed"
}
